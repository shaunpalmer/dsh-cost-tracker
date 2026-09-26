// ============================================================
// DSH 花费统计插件 —— Host 半端（静态版）
// 由动态版 cost-tracker.host.js 改造而来：
//   harness.handle  → webServer HTTP 路由（/api/cost-tracker/*）
//   harness.*Tool   → ctx.tools.register
//   subprocess node → 原生 fetch + node:fs
//   新增数据持久化 → ~/.dsh/storages/cost-tracker-records.json
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createStore, collectTotals, DETAIL_DAYS, MAX_AXIS_DAYS } from './store.js'
import { PRICE_ERAS, V41_EFFECTIVE_AT, V41_PRO_ROUTE_AT, exactModelsAt, eraAt, SUBSCRIPTION_RATES, PROVIDER_RATES, GENERIC_RATES, PEAK_WINDOWS, PEAK_HOUR_WINDOWS, isPeak, peakPhaseAt, priceFor, computeCost, normalizeTokens } from './pricing.js'
import {
  normalizePeakConfig, defaultPeakConfig, peakEffective,
  normalizeCloudConfig, defaultCloudConfig, normalizePluginConfig,
} from './config.js'
import { createSyncEngine, setPluginVersion, SOURCE as SYNC_SOURCE, SYNC_VERSION, loadIdentity } from './sync.js'
import { Schema } from './schema.js'

/** 插件版本（写入上报信封，便于云端排查版本差异） */
const PLUGIN_VERSION = '1.8.8'
setPluginVersion(PLUGIN_VERSION)

/** 「设置 → 插件 → 插件配置」里的卡片字段（与 settings 命名空间一致） */
const SyncSchema = Schema.object({
  deviceName: Schema.string().default(undefined).description('本机在看板上显示的名字'),
  cloudEnabled: Schema.boolean().default(undefined).description('启用云端同步'),
  cloudUrl: Schema.string().default(undefined).description('云端服务地址，如 https://cost.example.com'),
  cloudToken: Schema.string().role('secret').default(undefined).description('共享引导令牌 / 设备令牌'),
  syncIntervalSec: Schema.natural().default(undefined).description('自动同步间隔秒（15-3600）'),
  syncBatchSize: Schema.natural().default(undefined).description('单批明细条数（50-2000）'),
  maskSessionId: Schema.boolean().default(undefined).description('会话脱敏（上报前做不可逆哈希）'),
  includePurpose: Schema.boolean().default(undefined).description('上报 purpose（项目归属）'),
  syncRollups: Schema.boolean().default(undefined).description('上报历史日汇总快照'),
  syncSinceDays: Schema.natural().default(undefined).description('补传起始窗口天数（0 = 不限）'),
  cloudView: Schema.string().default(undefined).description('看板视图：local / local+cloud / cloud'),
})

// ============================================================
// 启动信息日志开关（默认静默）
//   设置 DSH_COST_TRACKER_LOG=1（或 true/yes/on）后，dsh web 启动时会打印：
//   nav-icon 自检结果、数据恢复报告、就绪标记。
//   错误日志（持久化失败、文件损坏等 console.error）始终打印，不受此开关影响。
// ============================================================
const STARTUP_LOG = /^(1|true|yes|on)$/i.test(String(process.env.DSH_COST_TRACKER_LOG || ''))
function startupLog(msg) {
  if (STARTUP_LOG) console.log(msg)
}

// ============================================================
// 设置侧边栏图标补丁 · 启动自愈
// DSH 设置外壳的 navIcon() 按 id 硬编码图标，未知 id 回退齿轮；
// slot 注册不支持自带图标，只能给外壳产物打补丁。
// DSH 升级/重装会覆盖外壳文件 —— 因此每次启动自检，缺失即重打。
// 任何一步失败都静默跳过（侧边栏回退齿轮，面板内图标不受影响）。
// ============================================================
const NAV_ICON_BRANCH = 'if (id === "cost-dashboard") return (0, react_jsx_runtime.jsxs)("svg", { className: SettingsRoot_module_css_default.navIcon, width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", children: [(0, react_jsx_runtime.jsx)("rect", { x: 1.5, y: 8.6, width: 3.1, height: 5.9, rx: 0.9, fill: "currentColor" }), (0, react_jsx_runtime.jsx)("rect", { x: 5.9, y: 5.2, width: 3.1, height: 9.3, rx: 0.9, fill: "currentColor" }), (0, react_jsx_runtime.jsxs)("g", { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round", children: [(0, react_jsx_runtime.jsx)("path", { d: "M10.7 4.9 L12.3 7.2 L13.9 4.9" }), (0, react_jsx_runtime.jsx)("path", { d: "M12.3 7.2 L12.3 10.9" }), (0, react_jsx_runtime.jsx)("path", { d: "M10.9 7.8 L13.7 7.8" }), (0, react_jsx_runtime.jsx)("path", { d: "M10.9 9.5 L13.7 9.5" })] })] }); // cost-tracker-icon-patch\n\t\t\t'

export function ensureNavIconPatch(opts) {
  const log = (opts && opts.log) || (() => {})
  try {
    const entry = (opts && opts.entry) || (process.argv && process.argv[1]) || ''
    // 全局安装通常通过符号链接启动（如 /opt/homebrew/bin/dsh），需同时尝试 realpath
    const entries = [entry]
    try { const real = realpathSync(entry); if (real && real !== entry) entries.push(real) } catch (e) {}
    let shellFile = ''
    for (const e0 of entries) {
      let dir = dirname(e0)
      for (let i = 0; i < 8 && dir && dir !== dirname(dir); i++) {
        const candidate = join(dir, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js')
        if (existsSync(candidate)) { shellFile = candidate; break }
        dir = dirname(dir)
      }
      if (shellFile) break
    }
    if (!shellFile) { log('skip: settings shell not found'); return false }
    const src = readFileSync(shellFile, 'utf8')
    if (src.includes('id === "cost-dashboard"')) { log('ok: already patched'); return true }
    const anchor = /function navIcon\(id\)\s*\{\s*/.exec(src)
    if (!anchor) { log('skip: navIcon() not found (shell layout changed?)'); return false }
    if (!src.includes('react_jsx_runtime') || !src.includes('SettingsRoot_module_css_default')) {
      log('skip: expected identifiers missing (shell layout changed?)'); return false
    }
    if (!existsSync(shellFile + '.cost-tracker-bak')) writeFileSync(shellFile + '.cost-tracker-bak', src)
    const at = anchor.index + anchor[0].length
    const tmp = shellFile + '.cost-tracker-tmp'
    writeFileSync(tmp, src.slice(0, at) + NAV_ICON_BRANCH + src.slice(at))
    renameSync(tmp, shellFile)
    log('ok: patch applied -> ' + shellFile)
    return true
  } catch (e) {
    log('skip: ' + String(e && e.message ? e.message : e))
    return false
  }
}

export default {
  name: 'cost-tracker',
  inject: ['tools', 'webServer'],
  apply(ctx) {
    // 侧边栏图标补丁自愈（DSH 升级覆盖外壳后自动重打；失败静默跳过）
    ensureNavIconPatch({ log: (m) => startupLog('[cost-tracker] nav-icon ' + m) })

    // ---------- price tables (CNY per 1M tokens) ----------
    // 单价表 / 峰谷 / 费用计算集中在 pricing.js（纯模块，可独立测试）；
    // 单价按「计费时代」分版（PRICE_ERAS）：按记录时间戳选版，故历史记录口径不变。
    // V4.1 Flash 价（北京时间 2026-09-10 12:00 起）生效后，旧 V4-Flash 系的请求路由到
    // V4.1 Flash 计费；V4-Pro 自北京时间 2026-09-14 12:00 起才路由（官方通告口径）。
    // 记录一律以官方现役模型名 `deepseek-flash` 入账。
    // 视觉模型 deepseek-v4-flash-vision-exp 的图片 token 由接口 usage 计入 inputTokens

    // ---------- state ----------
    // 注意：records/rollups 在 persistence 段由 store 初始化（details/rollups 引用）
    let kimiCache = null

    // ---------- small helpers ----------
    function pad2(n) { return n < 10 ? '0' + n : '' + n }
    function toInt(x) { const n = parseInt(x, 10); return isNaN(n) ? 0 : n }
    function toStr(x) { return x === undefined || x === null ? '' : String(x) }
    function r2(x) { return Math.round(x * 100) / 100 }
    function r4(x) { return Math.round(x * 10000) / 10000 }
    function normProvider(p) { return toStr(p).toLowerCase().replace(/-official$/, '') }
    function dayKey(ts) {
      const d = new Date(ts + 28800000)
      return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
    }
    function timeLabel(ts) {
      const d = new Date(ts + 28800000)
      return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
    }

    // ---------- persistence ----------
    // 数据文件路径：可用环境变量 DSH_COST_TRACKER_STORE 覆盖（测试/自定义用）；
    // 默认 $DSH_HOME/storages/cost-tracker-records.json（未设 DSH_HOME 时为 ~/.dsh）。
    // 明细保留最近 DETAIL_DAYS 天，更早自动压缩为永久日汇总（见 store.js）。
    const STORE_FILE = process.env.DSH_COST_TRACKER_STORE || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'cost-tracker-records.json')
    const store = createStore(STORE_FILE)
    const records = store.details
    const rollups = store.rollups

    function writeRecords() { store.persist() }

    // ---------- plugin config（峰谷计价 + 云端同步） ----------
    // 与记录分开存储：$DSH_HOME/storages/cost-tracker-config.json。
    // 提供读写与校验（默认值见 config.js），写失败不阻断（下次改设置重试）。
    // 若部署里存在 @deepseek-ai/dsh-settings（本机 DSH 自带），另外注册一个
    // `cost-tracker` 命名空间：用户在「设置 → 插件 → 插件配置」里改的字段
    // 通过 settings/updated 回灌到本文件，保证两个入口读写同一份配置。
    const CONFIG_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'cost-tracker-config.json')
    let peakConfig = defaultPeakConfig()
    let cloudConfig = defaultCloudConfig()
    let configLoadWarned = false

    function loadConfig() {
      try {
        if (!existsSync(CONFIG_FILE)) return
        const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
        peakConfig = normalizePeakConfig(parsed)
        cloudConfig = normalizeCloudConfig(parsed)
      } catch (e) {
        if (!configLoadWarned) { console.error('cost tracker config load failed, using defaults', e); configLoadWarned = true }
      }
    }

    function saveConfig() {
      try {
        mkdirSync(dirname(CONFIG_FILE), { recursive: true })
        const tmp = CONFIG_FILE + '.tmp'
        writeFileSync(tmp, JSON.stringify(Object.assign({}, peakConfig, cloudConfig)), 'utf8')
        renameSync(tmp, CONFIG_FILE)
        return true
      } catch (e) {
        console.error('cost tracker config persist failed', e)
        return false
      }
    }

    function setPeakConfig(raw) {
      peakConfig = normalizePeakConfig(Object.assign({}, peakConfig, raw))
      saveConfig()
      return peakConfig
    }

    function setCloudConfig(raw) {
      cloudConfig = normalizeCloudConfig(Object.assign({}, cloudConfig, raw))
      saveConfig()
      return cloudConfig
    }

    // ---------- settings 命名空间（可选服务） ----------
    // 字段全部 .default(undefined)：只有用户在卡片里显式保存才写入用户层，
    // 从而不覆盖我们自己配置文件里的既有值。
    // hooks.setSource/onChange 由宿主调用；schema.js 提供零依赖的同形状 schema。
    let settingsScope = null
    let settingsSource = () => ({})
    let settingsCardInstalled = false

    function applySettingsPatch(next) {
      if (!next || typeof next !== 'object') return
      const patch = {}
      for (const k of Object.keys(next)) if (next[k] !== undefined) patch[k] = next[k]
      if (!Object.keys(patch).length) return
      const before = JSON.stringify(cloudConfig)
      cloudConfig = normalizeCloudConfig(Object.assign({}, cloudConfig, patch))
      if (JSON.stringify(cloudConfig) !== before) saveConfig()
    }

    function installSettingsSection(provider, owner) {
      if (settingsScope) return true // 幂等：宿主对同一 ns 二次注册会抛 "already registered"
      const settings = provider || ctx.get('settings')
      if (!settings || typeof settings.installSection !== 'function') return false
      try {
        settingsScope = settings.installSection(owner || ctx, 'cost-tracker', SyncSchema, {}, {
          setSource(getter) { settingsSource = typeof getter === 'function' ? getter : (() => ({})) },
          onChange() { settingsCardInstalled = true; applySettingsPatch(settingsSource()) },
          validate(value) { return normalizeCloudConfig(Object.assign({}, cloudConfig, value || {})) },
        })
        applySettingsPatch(settingsSource())
        return true
      } catch (e) {
        startupLog('settings section skipped: ' + String(e && e.message ? e.message : e))
        return false
      }
    }

    /** 把当前配置回写给 settings 命名空间（卡片已打开时保持同步） */
    function publishSettings() {
      if (!settingsScope || typeof settingsScope.update !== 'function') return
      try { settingsScope.update({}) } catch (e) { /* 只读或未就绪：忽略 */ }
    }

    // 峰谷相位快照（供客户端时段条 / 弹窗 / 倒计时）
    function peakSnapshot() {
      const now = Date.now()
      const phase = peakPhaseAt(now)
      return {
        ok: true,
        config: peakConfig,
        enabled: peakConfig.peakEnabled,
        effective: peakEffective(peakConfig, now),
        notice: peakConfig.peakNotice,
        style: peakConfig.peakStyle,
        alert: {
          enabled: peakConfig.peakAlertEnabled,
          ahead: peakConfig.peakAlertAhead,
          target: peakConfig.peakAlertTarget,
          position: peakConfig.peakAlertPosition,
          webNotify: peakConfig.peakAlertWebNotify,
        },
        phase,
        peakWindows: PEAK_WINDOWS,
        peakHours: PEAK_HOUR_WINDOWS,
        effectiveAt: peakConfig.peakEffectiveAt,
        now,
      }
    }

    function loadRecords() {
      const n = store.load()
      const ru = Object.keys(rollups).length
      if (n > 0 || ru > 0) startupLog('cost tracker restored ' + n + ' detail records, ' + ru + ' rollup days from ' + STORE_FILE)
    }

    let persistPending = false
    let persistTimer = null
    function schedulePersist() {
      if (persistPending) return
      persistPending = true
      const run = () => {
        persistPending = false
        persistTimer = null
        writeRecords()
      }
      const timer = ctx.get('timer')
      persistTimer = timer ? timer.timeout(run, 1500) : setTimeout(run, 1500)
    }
    function persistNow() {
      persistPending = false
      if (persistTimer) { try { persistTimer() } catch (e) {} persistTimer = null }
      writeRecords()
    }

    // ---------- recording ----------
    function recordUsage(options, usage, ts) {
      const provider = toStr(options && options.provider)
      const model = toStr(options && options.model)
      if (!provider && !model) return
      const np = normProvider(provider)
      // 按「调用发生的时刻」选单价版本（跨 2026-09-10 12:00 / 2026-09-14 12:00 自动切换，无需重启）。
      const price = priceFor(np, model, ts)
      // 峰谷计费开关：随配置峰谷启用 + 生效时间门控；未启用时按非峰谷档（平价）计费。
      const peak = peakEffective(peakConfig, ts) ? isPeak(ts) : false
      // 视觉模型（deepseek-v4-flash-vision-exp）的图片 token 已含在接口
      // prompt_tokens 中（每张≤384 tokens），由 normalizeTokens 归入 input
      const tokens = normalizeTokens(usage)
      store.add({
        // 被路由的请求以「实际计费模型规范名」入账（如 V4-Pro → deepseek-flash、
        // 旧名 deepseek-v4-flash → deepseek-flash），使按模型聚合看到的就是真实计费口径。
        ts, provider, model: price.model || model,
        sessionId: toStr(options && options.sessionId),
        purpose: toStr(options && options.purpose),
        cost: computeCost(price.rates, price.tiered, peak, tokens),
        estimated: price.estimated,
        period: price.tiered ? (peak ? 'peak' : 'off-peak') : 'flat',
        tokens,
        subscription: price.subscription,
      })
      schedulePersist()
      scheduleSync(4000)
    }

    async function* wrapStream(source, options) {
      let usage = null
      try {
        for await (const chunk of source) {
          if (chunk && chunk.type === 'usage' && chunk.usage) usage = chunk.usage
          yield chunk
        }
      } finally {
        if (usage) {
          try { recordUsage(options, usage, Date.now()) } catch (e) { console.error('cost record failed', e) }
        }
      }
    }

    ctx.on('llm/stream', (options, next) => wrapStream(next(), options))

    // ---------- network (native fetch) ----------
    async function httpJson(url, headers, timeoutMs) {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), timeoutMs || 15000)
      try {
        const r = await fetch(url, { headers: headers || {}, signal: ac.signal })
        const body = await r.text()
        return { status: r.status, body: body.slice(0, 12000) }
      } catch (e) {
        return { status: 0, error: String(e && e.message ? e.message : e) }
      } finally {
        clearTimeout(t)
      }
    }

    // ---------- key resolution ----------
    function readCredFile(envName) {
      try {
        const p = join(homedir(), '.dsh', '.credentials.yaml')
        const t = readFileSync(p, 'utf8')
        const lines = t.split(/\r?\n/)
        for (const line of lines) {
          const m = line.match(/^([A-Za-z0-9_]+):\s*(.+)\s*$/)
          if (m && m[1] === envName) return m[2]
        }
      } catch (e) {}
      return ''
    }

    function kimiKeyEnv() {
      const settings = ctx.get('settings')
      if (settings) {
        try {
          const v = settings.get('llm-pi-ai')
          const providers = v && v.providers
          if (providers) {
            const kc = providers['kimi-coding']
            if (kc && kc.apiKeyEnv) return String(kc.apiKeyEnv)
            const k = providers['kimi']
            if (k && k.apiKeyEnv) return String(k.apiKeyEnv)
          }
        } catch (e) {}
      }
      return 'KIMI_CODING_API_KEY'
    }

    function deepseekKeyEnv() {
      const settings = ctx.get('settings')
      if (settings) {
        try {
          const v = settings.get('llm-deepseek')
          if (v && v.apiKeyEnv) return String(v.apiKeyEnv)
        } catch (e) {}
        try {
          const v = settings.get('llm-pi-ai')
          const p = v && v.providers && v.providers['deepseek']
          if (p && p.apiKeyEnv) return String(p.apiKeyEnv)
        } catch (e) {}
      }
      return 'DEEPSEEK_API_KEY'
    }

    async function resolveApiKey(envName) {
      const cred = ctx.get('credentials')
      if (cred) {
        try {
          const r = await cred.resolve(envName)
          if (r && r.value) return { value: String(r.value), source: 'credentials:' + toStr(r.source) }
        } catch (e) {}
      }
      const v = readCredFile(envName)
      if (v) return { value: v, source: 'file' }
      return { value: '', source: 'none' }
    }

    // ---------- kimi subscription quota ----------
    function emptyKimi(error, keySource, keyEnv) {
      return { ok: false, error, weekly: { used: 0, limit: 0, remaining: 0, resetTime: '' }, windows: [], parallel: 0, membership: '', region: '', fetchedAt: Date.now(), keySource, keyEnv }
    }

    function parseKimi(j, key, keyEnv) {
      const u = j && j.usage ? j.usage : {}
      const windows = []
      const limits = j && j.limits
      if (Array.isArray(limits)) {
        for (const l of limits) {
          const w = l && l.window ? l.window : {}
          const d = l && l.detail ? l.detail : {}
          windows.push({ duration: toInt(w.duration), timeUnit: toStr(w.timeUnit), used: toInt(d.used), limit: toInt(d.limit), remaining: toInt(d.remaining), resetTime: toStr(d.resetTime) })
        }
      }
      const user = j && j.user ? j.user : {}
      const membership = user.membership ? user.membership.level : ''
      return {
        ok: true, error: '',
        weekly: { used: toInt(u.used), limit: toInt(u.limit), remaining: toInt(u.remaining), resetTime: toStr(u.resetTime) },
        windows,
        parallel: toInt(j && j.parallel ? j.parallel.limit : 0),
        membership: toStr(membership),
        region: toStr(user.region),
        fetchedAt: Date.now(),
        keySource: key.source, keyEnv,
      }
    }

    async function kimiUsage(force) {
      const now = Date.now()
      if (!force && kimiCache && now - kimiCache.fetchedAt < 120000) return kimiCache.data
      const envName = kimiKeyEnv()
      let data
      try {
        const key = await resolveApiKey(envName)
        if (!key.value) {
          data = emptyKimi('未找到 API Key（' + envName + '）', key.source, envName)
        } else {
          const headers = { Authorization: 'Bearer ' + key.value, 'User-Agent': 'KimiCLI/1.6' }
          let r = await httpJson('https://api.kimi.com/coding/v1/usages', headers)
          if (r.status === 404) r = await httpJson('https://api.kimi.com/coding/v1/usage', headers)
          if (r.status === 200 && r.body) {
            try {
              data = parseKimi(JSON.parse(r.body), key, envName)
            } catch (e) {
              data = emptyKimi('响应解析失败', key.source, envName)
            }
          } else {
            data = emptyKimi('HTTP ' + (r.status || 0) + (r.error ? ' · ' + r.error : ''), key.source, envName)
          }
        }
      } catch (e) {
        data = emptyKimi(toStr(e && e.message ? e.message : e), 'none', envName)
      }
      kimiCache = { fetchedAt: now, data }
      return data
    }

    // ---------- deepseek balance ----------
    async function balance(args) {
      const manual = args && typeof args.apiKey === 'string' ? args.apiKey.trim() : ''
      const key = manual ? { value: manual, source: 'manual' } : await resolveApiKey(deepseekKeyEnv())
      if (!key.value) return { ok: false, error: '未找到 DeepSeek API Key', available: false, total: '', granted: '', toppedUp: '', currency: 'CNY', keySource: 'none' }
      try {
        const r = await httpJson('https://api.deepseek.com/user/balance', { Authorization: 'Bearer ' + key.value })
        if (r.status !== 200 || !r.body) return { ok: false, error: 'HTTP ' + (r.status || 0) + (r.error ? ' · ' + r.error : ''), available: false, total: '', granted: '', toppedUp: '', currency: 'CNY', keySource: key.source }
        const j = JSON.parse(r.body)
        const infos = Array.isArray(j.balance_infos) ? j.balance_infos : []
        // DeepSeek returns the account's own billing currency. Do NOT prefer CNY:
        // on a USD account that picks a balance in the wrong currency, which the
        // client then converts with the CNY -> NZD rate.
        const info = infos[0] || {}
        return { ok: true, error: '', available: !!j.is_available, total: toStr(info.total_balance), granted: toStr(info.granted_balance), toppedUp: toStr(info.topped_up_balance), currency: toStr(info.currency) || 'CNY', keySource: key.source }
      } catch (e) {
        return { ok: false, error: toStr(e && e.message ? e.message : e), available: false, total: '', granted: '', toppedUp: '', currency: 'CNY', keySource: key.source }
      }
    }

    // ---------- csv export ----------
    function csvCell(s) {
      s = String(s)
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }

    function workspaceRoot() {
      const policy = ctx.get('sandboxPolicy')
      if (policy && policy.workspaceRoot) return policy.workspaceRoot
      return process.cwd()
    }

    async function exportCsv() {
      const rows = records.slice(-50000)
      const lines = ['time,provider,model,sessionId,purpose,period,subscription,estimated,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens,costCNY']
      for (const r of rows) {
        const t = r.tokens
        const d = new Date(r.ts + 28800000)
        const ts = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds())
        lines.push([csvCell(ts), csvCell(r.provider), csvCell(r.model), csvCell(r.sessionId), csvCell(r.purpose), r.period, r.subscription ? '1' : '0', r.estimated ? '1' : '0', t.input, t.output, t.cacheRead, t.cacheWrite, t.input + t.output + t.cacheRead + t.cacheWrite, r4(r.cost)].join(','))
      }
      // 日汇总行（purpose=rollup）：早于保留窗口的记录按天+模型聚合后永久保留
      let rollupRows = 0
      for (const dk of Object.keys(rollups).sort()) {
        for (const mk of Object.keys(rollups[dk]).sort()) {
          const e = rollups[dk][mk]
          const total = e.input + e.output + e.cacheRead + e.cacheWrite
          lines.push([csvCell(dk + ' 12:00:00'), csvCell(e.provider), csvCell(e.model), '', 'rollup', '', e.subscription ? '1' : '0', e.estimated ? '1' : '0', e.input, e.output, e.cacheRead, e.cacheWrite, total, r4(e.cost)].join(','))
          rollupRows += 1
        }
      }
      const csv = '\uFEFF' + lines.join('\n') + '\n'
      const name = 'cost-export-' + dayKey(Date.now()) + '.csv'
      try {
        const path = join(workspaceRoot(), name)
        writeFileSync(path, csv, 'utf8')
        return { ok: true, path, count: rows.length + rollupRows, error: '' }
      } catch (e) {
        return { ok: false, path: '', count: 0, error: toStr(e && e.message ? e.message : e).slice(0, 300) }
      }
    }

    // ---------- prices ----------
    function prices() {
      const now = Date.now()
      const era = eraAt(now)
      return {
        peakWindows: PEAK_WINDOWS,
        offPeakFactor: 0.5,
        unit: 'CNY / 1M tokens',
        // exact = 当前生效时代的精确单价表（随价格时代自动切换）
        exact: exactModelsAt(now),
        era: era.id,
        eraLabel: era.label,
        // 全部价格时代（含生效时刻与路由规则），供工具/接口展示
        eras: PRICE_ERAS.map((e) => ({ id: e.id, label: e.label, since: e.since, models: e.models, routes: e.routes || {} })),
        v41EffectiveAt: V41_EFFECTIVE_AT,
        v41ProRouteAt: V41_PRO_ROUTE_AT,
        subscription: SUBSCRIPTION_RATES,
        providers: PROVIDER_RATES,
        generic: GENERIC_RATES,
      }
    }

    // ---------- aggregation ----------
    function enumerateDays(startKey, endKey) {
      const out = []
      let t = Date.UTC(toInt(startKey.slice(0, 4)), toInt(startKey.slice(5, 7)) - 1, toInt(startKey.slice(8, 10)))
      const end = Date.UTC(toInt(endKey.slice(0, 4)), toInt(endKey.slice(5, 7)) - 1, toInt(endKey.slice(8, 10)))
      if (end - t > (MAX_AXIS_DAYS - 1) * 86400000) t = end - (MAX_AXIS_DAYS - 1) * 86400000
      while (t <= end) {
        const d = new Date(t)
        out.push({ key: d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()), label: (d.getUTCMonth() + 1) + '/' + d.getUTCDate() })
        t += 86400000
      }
      return out
    }

    function buildDashboard(args) {
      const days = args && typeof args.days === 'number' && isFinite(args.days) ? Math.max(0, Math.floor(args.days)) : 7
      const now = Date.now()
      const todayKey = dayKey(now)
      const cutoff = days > 0 ? now - days * 86400000 : 0
      const filt = []
      for (const r of records) if (r.ts >= cutoff) filt.push(r)
      // 保留窗口外的日汇总（按天+模型），仅取落在查询范围内的天
      const ru = {}
      {
        const startDk = dayKey(cutoff)
        for (const dk of Object.keys(rollups)) if (dk >= startDk) ru[dk] = rollups[dk]
      }
      let realCost = 0, realTokens = 0, peakCost = 0, offCost = 0, flatCost = 0, realCalls = 0
      let subEquivalent = 0, subTokens = 0, subCalls = 0
      // 今日（北京日历日）：消费 / 调用 / tokens，按量与订阅分开
      let todayReal = 0, todayCalls = 0, todayTokens = 0, todaySub = 0, todaySubCalls = 0, todaySubTokens = 0
      // 本月（北京日历月）：同样按量/订阅分开
      const monthPrefix = todayKey.slice(0, 7) // YYYY-MM
      let monthReal = 0, monthCalls = 0, monthTokens = 0, monthSub = 0, monthSubCalls = 0, monthSubTokens = 0
      const modelMap = {}
      for (const r of filt) {
        const t = r.tokens
        const total = t.input + t.output + t.cacheRead + t.cacheWrite
        const key = r.provider + '/' + r.model
        let m = modelMap[key]
        if (!m) m = modelMap[key] = { model: key, subscription: r.subscription, estimated: r.estimated, calls: 0, tokens: 0, cost: 0, dayMap: {} }
        m.calls += 1; m.tokens += total; m.cost += r.cost
        const dk = dayKey(r.ts)
        let dm = m.dayMap[dk]
        if (!dm) dm = m.dayMap[dk] = { calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
        dm.calls += 1; dm.tokens += total; dm.input += t.input; dm.output += t.output; dm.cacheRead += t.cacheRead; dm.cacheWrite += t.cacheWrite; dm.cost += r.cost
        if (dk === todayKey) {
          if (r.subscription) { todaySub += r.cost; todaySubCalls += 1; todaySubTokens += total }
          else { todayReal += r.cost; todayCalls += 1; todayTokens += total }
        }
        if (r.subscription) { subCalls += 1; subEquivalent += r.cost; subTokens += total }
        else {
          realCalls += 1; realCost += r.cost; realTokens += total
          if (r.period === 'peak') peakCost += r.cost
          else if (r.period === 'off-peak') offCost += r.cost
          else flatCost += r.cost
        }
      }
      // 本月（北京日历月）：与查询窗口无关，扫全部明细记录（本月必在 180 天明细窗口内）
      for (const r of records) {
        if (dayKey(r.ts).slice(0, 7) !== monthPrefix) continue
        const total = r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite
        if (r.subscription) { monthSub += r.cost; monthSubCalls += 1; monthSubTokens += total }
        else { monthReal += r.cost; monthCalls += 1; monthTokens += total }
      }
      // 全时段累计（明细 + 永久日汇总），永远精确
      const full = collectTotals(records, rollups)
      // 合并日汇总到总量 / 模型 / 按天明细
      for (const dk of Object.keys(ru)) {
        for (const mk of Object.keys(ru[dk])) {
          const e = ru[dk][mk]
          const total = e.input + e.output + e.cacheRead + e.cacheWrite
          let m = modelMap[mk]
          if (!m) m = modelMap[mk] = { model: mk, subscription: e.subscription, estimated: e.estimated, calls: 0, tokens: 0, cost: 0, dayMap: {} }
          m.calls += e.calls; m.tokens += total; m.cost += e.cost
          let dm = m.dayMap[dk]
          if (!dm) dm = m.dayMap[dk] = { calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
          dm.calls += e.calls; dm.tokens += total; dm.input += e.input; dm.output += e.output; dm.cacheRead += e.cacheRead; dm.cacheWrite += e.cacheWrite; dm.cost += e.cost
          if (e.subscription) { subCalls += e.calls; subEquivalent += e.cost; subTokens += total }
          else {
            realCalls += e.calls; realCost += e.cost; realTokens += total
            peakCost += e.peak; offCost += e.off; flatCost += e.flat
          }
        }
      }
      const endKey = dayKey(now)
      let startKey = endKey
      if (days > 0) startKey = dayKey(cutoff)
      else if (filt.length > 0) startKey = dayKey(filt[0].ts)
      const ruKeys = Object.keys(ru)
      if (ruKeys.length) {
        const earliest = ruKeys.sort()[0]
        if (earliest < startKey) startKey = earliest
      }
      const dates = enumerateDays(startKey, endKey)
      const dayAgg = {}
      for (const d of dates) dayAgg[d.key] = { peak: 0, off: 0, flat: 0 }
      for (const r of filt) {
        if (r.subscription) continue
        const m = dayAgg[dayKey(r.ts)]
        if (!m) continue
        if (r.period === 'peak') m.peak += r.cost
        else if (r.period === 'off-peak') m.off += r.cost
        else m.flat += r.cost
      }
      for (const dk of Object.keys(ru)) {
        const m = dayAgg[dk]
        if (!m) continue
        for (const mk of Object.keys(ru[dk])) {
          const e = ru[dk][mk]
          if (e.subscription) continue
          m.peak += e.peak; m.off += e.off; m.flat += e.flat
        }
      }
      const byDay = dates.map(d => ({ date: d.key, label: d.label, peak: r4(dayAgg[d.key].peak), off: r4(dayAgg[d.key].off), flat: r4(dayAgg[d.key].flat) }))
      // 模型展示顺序：按总费用降序排名（与 DeepSeek 开放平台一致，排名决定取色/堆叠顺序）
      const keys = Object.keys(modelMap).sort((a, b) => modelMap[b].cost - modelMap[a].cost)
      const byModel = keys.map(k => {
        const m = modelMap[k]
        return { model: m.model, subscription: m.subscription, estimated: m.estimated, calls: m.calls, tokens: m.tokens, cost: r4(m.cost) }
      })
      const byModelDay = keys.map(k => {
        const m = modelMap[k]
        return {
          model: m.model, subscription: m.subscription, estimated: m.estimated,
          days: dates.map(d => {
            const dm = m.dayMap[d.key]
            return { date: d.key, label: d.label, calls: dm ? dm.calls : 0, tokens: dm ? dm.tokens : 0, input: dm ? dm.input : 0, output: dm ? dm.output : 0, cacheRead: dm ? dm.cacheRead : 0, cacheWrite: dm ? dm.cacheWrite : 0, cost: dm ? r4(dm.cost) : 0 }
          }),
        }
      })
      const recent = []
      const start = Math.max(0, records.length - 20)
      for (let i = records.length - 1; i >= start; i--) {
        const r = records[i]
        const t = r.tokens
        recent.push({ ts: r.ts, time: timeLabel(r.ts), provider: r.provider, model: r.model, period: r.period, subscription: r.subscription, estimated: r.estimated, input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, tokens: t.input + t.output + t.cacheRead + t.cacheWrite, cost: r4(r.cost) })
      }
      return {
        ok: true, days,
        realCost: r4(realCost), realCalls, realTokens,
        subEquivalent: r4(subEquivalent), subCalls, subTokens,
        peakCost: r4(peakCost), offCost: r4(offCost), flatCost: r4(flatCost),
        today: { real: r4(todayReal), calls: todayCalls, tokens: todayTokens, sub: r4(todaySub), subCalls: todaySubCalls, subTokens: todaySubTokens },
        month: { real: r4(monthReal), calls: monthCalls, tokens: monthTokens, sub: r4(monthSub), subCalls: monthSubCalls, subTokens: monthSubTokens },
        all: { real: r4(full.realCost), calls: full.realCalls, tokens: full.realTokens, sub: r4(full.subEquivalent), subCalls: full.subCalls, subTokens: full.subTokens },
        byDay, byModel, byModelDay, recent,
        peakWindows: PEAK_WINDOWS,
      }
    }

    function buildSummary(args) {
      const sid = args && typeof args.sessionId === 'string' ? args.sessionId : ''
      const now = Date.now()
      const todayKey = dayKey(now)
      let sessionCost = 0, sessionCalls = 0, sessionSub = 0, sessionSubCalls = 0, todayCost = 0
      // 本会话按模型拆分（明细；订阅与按量分开，便于状态栏按会话实际内容展示）
      const realMap = {}, subMap = {}
      // 会话/当日只可能出现在明细里（日汇总早于保留窗口）
      for (const r of records) {
        if (r.subscription) {
          if (r.sessionId === sid) { sessionSub += r.cost; sessionSubCalls += 1 }
        } else {
          if (dayKey(r.ts) === todayKey) todayCost += r.cost
          if (r.sessionId === sid) { sessionCost += r.cost; sessionCalls += 1 }
        }
        if (r.sessionId === sid) {
          const key = r.provider + '/' + r.model
          const map = r.subscription ? subMap : realMap
          let m = map[key]
          if (!m) m = map[key] = { provider: r.provider, model: r.model, subscription: !!r.subscription, calls: 0, tokens: 0, cost: 0 }
          m.calls += 1
          m.tokens += (r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite)
          m.cost += r.cost
        }
      }
      const fmtModels = (map) => Object.keys(map).map(k => map[k]).sort((a, b) => b.cost - a.cost)
        .map(m => ({ provider: m.provider, model: m.model, subscription: m.subscription, calls: m.calls, tokens: m.tokens, cost: r4(m.cost) }))
      const realModels = fmtModels(realMap)
      const subModels = fmtModels(subMap)
      const sessionModels = realModels.concat(subModels).sort((a, b) => b.cost - a.cost)
      // 全时段总量 = 明细 + 永久日汇总，永远精确
      const full = collectTotals(records, rollups)
      let provider = '', model = ''
      const adm = ctx.get('agentDefaultModel')
      if (adm) {
        try {
          const sel = adm.currentSelection()
          if (sel) { provider = toStr(sel.provider); model = toStr(sel.model) }
        } catch (e) {}
      }
      const np = normProvider(provider)
      const subscription = !!SUBSCRIPTION_RATES[np]
      let kimiWeeklyRemaining = null
      // 只要当前选择是订阅，或本会话实际用了订阅，就刷新 kimi 周配额
      if (subscription || sessionSub > 0) {
        if (!kimiCache || now - kimiCache.fetchedAt >= 120000) kimiUsage(false).catch(() => {})
        if (kimiCache && kimiCache.data && kimiCache.data.ok) kimiWeeklyRemaining = kimiCache.data.weekly.remaining
      }
      return {
        sessionCost: r4(sessionCost), sessionCalls,
        sessionSub: r4(sessionSub), sessionSubCalls,
        sessionRealModels: realModels,
        sessionSubModels: subModels,
        sessionModels,
        todayCost: r4(todayCost), totalCost: r4(full.realCost), totalCalls: full.realCalls,
        subEquivalent: r4(full.subEquivalent), subCalls: full.subCalls, subTokens: full.subTokens,
        provider, model,
        isDeepSeek: np === 'deepseek',
        peak: peakEffective(peakConfig, now) ? isPeak(now) : false,
        subscription,
        kimiWeeklyRemaining,
      }
    }

    function resetData() {
      const n = store.counts().calls
      store.clear()
      kimiCache = null
      persistNow()
      return { ok: true, cleared: n }
    }

    // ---------- 一次性补账：按「计费时代」重算已入库记录 ----------
    // 场景：价格时代切换时刻已过，但宿主仍加载着旧代码（插件未重启），
    // 这段时间入库的记录用的是旧价。重启后调用一次即可按记录**自身的时间戳**
    // 重新选版计费，无需重新采集。
    // 只重算明细：明细保留最近 DETAIL_DAYS 天，更早的记录早已折叠进日汇总，
    // 而日汇总覆盖的时间段远早于任何价格切换窗口，故不涉及。
    // **默认扫描全部明细**（since=0）：早期版本默认「自最近一个价格时代起算」，
    // 结果更早时代里被旧代码标错口径的记录（如现役名曾落入兜底而被标 estimated）
    // 会被静默跳过——补账只做一半却提示「无需重算」。补账是幂等的，全扫代价可忽略。
    // 默认只试算（不落盘），传 apply: true 才写回。
    function recomputeCosts(args) {
      const a = args || {}
      // since：显式传入（ISO 或 epoch ms）则按它限定时段；缺省 0 = 全时段。
      let since = 0
      if (typeof a.since === 'string' && Number.isFinite(Date.parse(a.since))) since = Date.parse(a.since)
      else if (Number.isFinite(a.since) && a.since >= 0) since = a.since
      const apply = a.apply === true
      const byModel = {}
      let scanned = 0, changed = 0, oldCost = 0, newCost = 0, estimatedFlips = 0
      for (const r of records) {
        if (!(r.ts >= since)) continue
        scanned += 1
        const np = normProvider(r.provider)
        const price = priceFor(np, r.model, r.ts)
        const peak = peakEffective(peakConfig, r.ts) ? isPeak(r.ts) : false
        const cost = computeCost(price.rates, price.tiered, peak, r.tokens)
        const model = price.model || r.model
        const period = price.tiered ? (peak ? 'peak' : 'off-peak') : 'flat'
        const estimated = price.estimated === true
        const subscription = price.subscription === true
        oldCost += r.cost
        newCost += cost
        // 变更判定含 estimated/subscription：模型名从兜底口径升为精确档时，
        // 金额可能分毫不变，但「估算」标记必须一并订正（否则看板长期误报估算占比）。
        const flip = (r.estimated === true) !== estimated || (r.subscription === true) !== subscription
        if (!(Math.abs(cost - r.cost) > 1e-9 || model !== r.model || period !== r.period || flip)) continue
        changed += 1
        if (flip) estimatedFlips += 1
        const key = r.provider + '|' + r.model + '|' + model
        const m = byModel[key] || (byModel[key] = { provider: r.provider, from: r.model, to: model, calls: 0, oldCost: 0, newCost: 0, flips: 0 })
        m.calls += 1
        m.oldCost += r.cost
        m.newCost += cost
        if (flip) m.flips += 1
        if (apply) {
          r.cost = cost
          r.model = model
          r.period = period
          r.estimated = estimated
          r.subscription = subscription
        }
      }
      if (apply && changed > 0) persistNow()
      const rows = Object.keys(byModel).map(k => {
        const m = byModel[k]
        return { provider: m.provider, from: m.from, to: m.to, calls: m.calls, oldCost: r4(m.oldCost), newCost: r4(m.newCost), delta: r4(m.newCost - m.oldCost), estimatedFlips: m.flips }
      }).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      return {
        ok: true,
        applied: apply && changed > 0,
        since,
        // since=0 表示全时段：此时不存在「单一时代」，era 返回 null（旧版会误报为 legacy）
        era: since === 0 ? null : eraAt(since).id,
        scanned,
        changed,
        estimatedFlips,
        oldCost: r4(oldCost),
        newCost: r4(newCost),
        delta: r4(newCost - oldCost),
        byModel: rows,
        note: changed === 0
          ? '没有需要重算的记录'
          : (apply
            ? '已重算并落盘' + (estimatedFlips ? '（其中 ' + estimatedFlips + ' 条仅订正「估算」标记，金额不变）' : '')
            : '试算结果，未落盘（传 apply: true 生效）'),
      }
    }

    // ---------- usage heatmap (Codex 风格 26 周每日用量方格热图) ----------
    // 返回全时段累计 token + 按天聚合（明细 + 永久日汇总），供客户端渲染热力图。
    // 汇总含按量与订阅（订阅为等效参考口径一致），days 覆盖最近约 27 周（含 26 周窗口余量）。
    function buildUsageHeat() {
      const now = Date.now()
      const byDay = {}
      const ensure = (dk) => {
        let d = byDay[dk]
        if (!d) d = byDay[dk] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0 }
        return d
      }
      let totInput = 0, totOutput = 0, totCacheRead = 0, totCacheWrite = 0, totCalls = 0, totCost = 0
      for (const r of records) {
        const t = r.tokens
        const d = ensure(dayKey(r.ts))
        d.input += t.input; d.output += t.output; d.cacheRead += t.cacheRead; d.cacheWrite += t.cacheWrite; d.calls += 1; d.cost += r.cost
        totInput += t.input; totOutput += t.output; totCacheRead += t.cacheRead; totCacheWrite += t.cacheWrite; totCalls += 1; totCost += r.cost
      }
      for (const dk of Object.keys(rollups)) {
        for (const mk of Object.keys(rollups[dk])) {
          const e = rollups[dk][mk]
          const d = ensure(dk)
          d.input += e.input; d.output += e.output; d.cacheRead += e.cacheRead; d.cacheWrite += e.cacheWrite; d.calls += e.calls; d.cost += e.cost
          totInput += e.input; totOutput += e.output; totCacheRead += e.cacheRead; totCacheWrite += e.cacheWrite; totCalls += e.calls; totCost += e.cost
        }
      }
      // 只保留最近约 27 周（客户端网格按周对齐，多留一周做余量，避免边缘缺格）
      const startDk = dayKey(now - 27 * 7 * 86400000)
      const days = []
      for (const dk of Object.keys(byDay).sort()) {
        if (dk < startDk) continue
        const d = byDay[dk]
        days.push({ date: dk, input: d.input, output: d.output, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite, calls: d.calls, cost: r4(d.cost), tokens: d.input + d.output + d.cacheRead + d.cacheWrite })
      }
      return {
        ok: true,
        total: {
          tokens: totInput + totOutput + totCacheRead + totCacheWrite,
          input: totInput, cache: totCacheRead + totCacheWrite, output: totOutput,
          calls: totCalls, cost: r4(totCost),
        },
        days,
      }
    }

    // ---------- cloud sync ----------
    // 同步引擎：只上报、不回写；失败只影响云端视图，绝不影响本地记账。
    const syncEngine = createSyncEngine({
      getConfig: () => Object.assign({}, peakConfig, cloudConfig),
      getSnapshot: () => ({
        details: records,
        rollups,
        resetEpoch: store.epoch(),
        maxSeq: store.maxSeq(),
        storageDir: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages'),
      }),
      setConfigField: (patch) => {
        const before = JSON.stringify(cloudConfig)
        cloudConfig = normalizeCloudConfig(Object.assign({}, cloudConfig, patch))
        if (JSON.stringify(cloudConfig) !== before) saveConfig()
      },
      now: () => Date.now(),
      log: (m) => startupLog('[cost-tracker] ' + m),
    })

    let syncTimer = null
    let syncDebounce = null
    function scheduleSync(delayMs) {
      if (!cloudConfig.cloudEnabled) return
      const timer = ctx.get('timer')
      if (syncDebounce) { try { syncDebounce() } catch (e) {} syncDebounce = null }
      const run = () => {
        syncDebounce = null
        syncEngine.runOnce({}).catch(() => {})
      }
      syncDebounce = timer ? timer.timeout(run, delayMs || 2000) : setTimeout(run, delayMs || 2000)
    }

    function startSyncTimer() {
      if (syncTimer) { try { syncTimer() } catch (e) {} syncTimer = null }
      if (!cloudConfig.cloudEnabled) return
      const interval = Math.max(15, Number(cloudConfig.syncIntervalSec) || 60) * 1000
      const timer = ctx.get('timer')
      const tick = () => { syncEngine.runOnce({}).catch(() => {}) }
      syncTimer = timer ? timer.interval(tick, interval) : setInterval(tick, interval)
    }

    /** 云端只读聚合（供看板三态视图与「设备 × Agent」下钻） */
    const cloudCache = new Map()

    /**
     * 三态视图的「其他机器」口径（云端 view 值 → 过滤方式）：
     *
     *   cloud        : 全网（不过滤）
     *   cloud-others : **其他整机**——排除本机整台（本机所有 agent 都不算）。
     *                  与「本机」视图相加 = 全网，本机恰好计一次。默认值。
     *   cloud-rest   : 除「本机 + DSH」以外的部分——排除本机设备 **且** 排除本机的 dsh 来源。
     *                  用于「本机+云端」把本机上的**其它 agent**（ZCode/Codex…）也并进来：
     *                  相加后 = 本机可见数据 + 其他整机 + 本机其它 agent，全程不重不漏。
     *
     * 「本机」的识别同时看设备 ID 与设备名（用户改名后云端 id 与本机 machineId 可能不一致），
     * 云端没有本机记录时回退为「不过滤」，宁可显示全网也不静默漏数据。
     */
    function cloudViewMode(v) {
      return v === 'cloud' ? 'cloud' : v === 'cloud-rest' ? 'cloud-rest' : 'cloud-others'
    }

    const deviceNameCache = { at: 0, list: [] }
    /** 云端能力探测（/api/v1/health 的 caps，缓存 60s）：决定能否用「插件形状」只读接口 */
    const cloudCapsCache = { at: 0, ok: false, pluginView: false }
    async function cloudCaps() {
      if (Date.now() - cloudCapsCache.at < 60000) return cloudCapsCache
      cloudCapsCache.at = Date.now()
      cloudCapsCache.ok = false
      cloudCapsCache.pluginView = false
      try {
        const res = await fetch(cloudConfig.cloudUrl + '/api/v1/health', { headers: { authorization: 'Bearer ' + cloudConfig.cloudToken } })
        const body = await res.json()
        if (body && body.ok === true) {
          cloudCapsCache.ok = true
          cloudCapsCache.pluginView = !!(body.caps && body.caps.devicePluginView)
        }
      } catch (e) { /* 探测失败按「旧云端」处理，走 overview 回退 */ }
      return cloudCapsCache
    }
    async function listCloudDevices() {
      if (Date.now() - deviceNameCache.at < 30000 && deviceNameCache.list.length) return deviceNameCache.list
      try {
        // 同上：设备维度清单也走设备令牌可读的 /api/v1/*
        const res = await fetch(cloudConfig.cloudUrl + '/api/v1/devices', { headers: { authorization: 'Bearer ' + cloudConfig.cloudToken } })
        const body = await res.json()
        if (body && body.ok && Array.isArray(body.devices)) {
          deviceNameCache.at = Date.now()
          deviceNameCache.list = body.devices.map((d) => ({ id: d.id, name: d.name, sources: d.sources || [] }));
        }
      } catch (e) { /* 拿不到清单时退回 excludeDevice */ }
      return deviceNameCache.list
    }

    async function fetchCloud(query) {
      if (!cloudConfig.cloudEnabled || !cloudConfig.cloudUrl || !cloudConfig.cloudToken) {
        return { ok: false, error: '云端同步未配置（在「设置 → 插件 → 插件配置 → 花费统计」填写服务地址与令牌）', code: 'NOT_CONFIGURED' }
      }
      const key = JSON.stringify(query)
      const hit = cloudCache.get(key)
      if (hit && Date.now() - hit.at < 10000) return hit.value
      const qs = new URLSearchParams()
      qs.set('range', query.range || '7d')
      if (query.days) qs.set('days', String(query.days))
      if (query.groupBy) qs.set('groupBy', query.groupBy)
      if (query.bucket) qs.set('bucket', query.bucket)
      if (Array.isArray(query.sources) && query.sources.length) qs.set('sources', query.sources.join(','))
      if (Array.isArray(query.devices) && query.devices.length) qs.set('devices', query.devices.join(','))
      const st = (query.view || query.excludeSelf === true) ? syncEngine.status() : null
      const mode = query.view ? cloudViewMode(query.view) : (query.excludeSelf === true ? 'cloud-others' : 'cloud')
      let selfId = ''
      let selfKnown = false
      let unionParts = null
      if (mode !== 'cloud' && !(query.devices && query.devices.length)) {
        // 识别「本机」：设备 ID 命中，或设备名与插件里配置的一致（用户改名后 id 可能不同）
        const all = await listCloudDevices()
        let myId = (st && st.deviceId) || ''
        if (!myId) { try { myId = loadIdentity().machineId } catch (e) { myId = '' } }
        const myName = ((st && st.deviceName) || '').trim()
        const isSelf = (d) => (myId && d.id === myId) || (myName && (d.name || '').trim() === myName)
        const self = all.filter(isSelf)
        selfId = (self[0] && self[0].id) || myId
        selfKnown = self.length > 0
        if (selfKnown) {
          if (mode === 'cloud-others') {
            qs.set('excludeDevice', selfId)
          } else if (selfId) {
            // cloud-rest：并集＝① 其他整机（排除本机设备） ② 本机上的其它 agent（本机设备 + 排除本来源）
            unionParts = [
              { excludeDevice: selfId },
              { devices: selfId, excludeSource: SYNC_SOURCE },
            ]
          }
        }
      }
      if (unionParts && query.route === 'overview') {
        // 只有 overview 支持并集（矩阵/趋势不做并集：口径复杂且易误读）
        qs.set('union', JSON.stringify(unionParts))
      } else if (mode === 'cloud-rest' && !selfKnown && selfId) {
        qs.set('excludeDevice', selfId) // 拿不到本机记录时退化为「排除本机整台」
      }
      // 只读聚合走 /api/v1/*（设备令牌可读）。/api/admin/* 只认管理员会话 cookie，
      // 采集端手里只有设备令牌，走那条必然 401 —— 这是 1.8.0~1.8.2 里「仅云端 /
      // 本机+云端」拿不到数据的根因。需要 dsh-cost-cloud ≥ 支持 /api/v1 只读接口的版本。
      //
      // 端点选择：
      //   · 概览路由在云端支持 /api/v1/plugin-view 时优先用它 —— 它一次返回**卡片 + 图表**
      //     的全套字段（today/month/all/byDay/byModel/byModelDay/recent），「仅云端」视图
      //     才能渲染消费柱状图、分模型明细与最近记录；旧云端没有该接口时回退 overview
      //     （卡片可用，图表为空），保证不因云端版本差异而整体不可用。
      //   · 带 union（「本机+云端」并集）时沿用 overview：其卡片是**全网**口径，与并集相加的
      //     语义一致；plugin-view 的卡片落在并集范围内，换成它会让总额口径突变。
      let endpoint = query.route
      if (query.route === 'overview' && !unionParts) {
        const caps = await cloudCaps()
        if (caps.pluginView) endpoint = 'plugin-view'
      }
      const url = cloudConfig.cloudUrl + '/api/v1/' + endpoint + '?' + qs.toString()
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 12000)
      try {
        const res = await fetch(url, { headers: { authorization: 'Bearer ' + cloudConfig.cloudToken }, signal: ac.signal })
        const body = await res.json().catch(() => null)
        if (!body || body.ok !== true) {
          const hint = res.status === 404
            ? '云端版本过旧：缺少设备只读接口 /api/v1/' + endpoint + '，请升级 dsh-cost-cloud 后重试'
            : null
          const out = { ok: false, error: hint || (body && body.error) || ('HTTP ' + res.status), code: (body && body.code) || (res.status === 404 ? 'CLOUD_TOO_OLD' : 'CLOUD_ERROR') }
          return out
        }
        const value = Object.assign({}, body, {
          source: 'cloud',
          asOf: Date.now(),
          cloudMode: mode,
          selfResolved: selfKnown,
          selfDeviceId: selfId,
          unionParts: unionParts,
        })
        cloudCache.set(key, { at: Date.now(), value })
        return value
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e), code: 'NETWORK' }
      } finally {
        clearTimeout(t)
      }
    }

    // ---------- HTTP routes (client → host) ----------
    const ROUTES = {
      summary: (args) => buildSummary(args),
      dashboard: (args) => buildDashboard(args),
      'kimi-usage': (args) => kimiUsage(!!(args && args.force)),
      balance: (args) => balance(args),
      export: () => exportCsv(),
      prices: () => prices(),
      recompute: (args) => recomputeCosts(args),
      usage: () => buildUsageHeat(),
      peak: () => peakSnapshot(),
      'peak-config': (args) => setPeakConfig(args),
      sync: () => syncEngine.status(),
      'sync-now': async (args) => {
        const result = await syncEngine.runOnce({ manual: true, full: !!(args && args.full) })
        return Object.assign({ ok: result.ok !== false || !result.error, result }, syncEngine.status())
      },
      'sync-test': async (args) => syncEngine.testConnection(args && args.config ? normalizeCloudConfig(Object.assign({}, cloudConfig, args.config)) : null),
      'sync-config': (args) => {
        const next = normalizeCloudConfig(Object.assign({}, cloudConfig, args || {}))
        const enabledChanged = next.cloudEnabled !== cloudConfig.cloudEnabled
        const intervalChanged = next.syncIntervalSec !== cloudConfig.syncIntervalSec
        cloudConfig = next
        saveConfig()
        if (enabledChanged || intervalChanged) startSyncTimer()
        if (args && args.cloudEnabled === true) scheduleSync(500)
        return Object.assign({ ok: true }, syncEngine.status())
      },
      cloud: (args) => fetchCloud(Object.assign({ route: 'overview', range: '7d' }, args || {})),
    }

    async function handleRoute(req, res) {
      const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
      const name = pathname.replace(/^\/api\/cost-tracker\//, '').replace(/\/+$/, '')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return }
      const fn = ROUTES[name]
      if (!fn) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'unknown route' })); return }
      let args = {}
      try {
        let raw = ''
        for await (const chunk of req) {
          raw += chunk
          if (raw.length > 1048576) break
        }
        if (raw) args = JSON.parse(raw)
      } catch (e) {}
      try {
        const out = await fn(args)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(JSON.stringify(out))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: toStr(e && e.message ? e.message : e) }))
      }
    }

    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/cost-tracker', handler: handleRoute }), 'cost-tracker: api routes')

    // ---------- model tools ----------
    // 注意：cost_stats 的定义在下方（支持 scope=local|cloud|both）；
    // 此处不再重复注册，避免同名工具冲突。

    ctx.tools.register({
      name: 'cost_prices',
      description: '查看当前内置的模型单价表（CNY / 百万 tokens）与峰谷时段规则。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, v) => {
          const when = (s) => (s === 0 ? '初始价（长期有效）' : new Date(s + 28800000).toISOString().replace('T', ' ').slice(0, 16).replace(/-/g, '/') + '（北京时间）')
          const lines = ['单价表（CNY / 百万 tokens）', '峰谷时段（北京时间）：' + v.peakWindows + '，闲时 = 高峰价 × ' + v.offPeakFactor]
          for (const e of v.eras) {
            lines.push('', '【' + e.label + '】生效：' + when(e.since))
            for (const name of Object.keys(e.models)) {
              const r = e.models[name]
              lines.push('  ' + name + '：高峰 输入（未命中）' + r.input + ' / 输入（命中）' + r.cacheRead + ' / 输出 ' + r.output + '（闲时半价）')
            }
            for (const from of Object.keys(e.routes)) {
              lines.push('  ↳ 路由：' + from + ' → 按 ' + e.routes[from] + ' 单价计费')
            }
          }
          lines.push('', '当前生效：' + v.eraLabel + '（era=' + v.era + '）')
          lines.push('模型名口径：官方现役名为 deepseek-flash（被路由的请求一律以此名入账）；deepseek-v4.1-flash 等写法归一化后命中同一档。')
          lines.push('V4-Pro 路由生效：' + when(v.v41ProRouteAt) + '（此前 deepseek-v4-pro 仍按 V4-Pro 自有牌价计费）。')
          lines.push('视觉模型 deepseek-v4-flash-vision-exp：图片按官方规则换算 token（每张上限 384），以接口用量计费（已含在 inputTokens 内）。')
          lines.push('kimi-coding（订阅等效，估算）：输入 6.5 / 缓存命中（含缓存写入）1.1 / 输出 27.0')
          lines.push('缓存写入(cache write)按缓存命中价计费，与官方规则一致。其他 provider 兜底为估算平价（openai 10/30/5，anthropic 15/75/1.5，gemini 2.5/10/0.625，未知 2/8/0.5）；ollama/local 为 0。')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: async () => prices(),
    })

    ctx.tools.register({
      name: 'cost_reset',
      description: '清空本进程内记录的全部模型调用花费与用量数据（同时清空磁盘持久化，不可恢复）。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, v) => [{ type: 'text', text: '已清空 ' + v.cleared + ' 条花费记录。' }],
      },
      execute: async () => resetData(),
    })

    ctx.tools.register({
      name: 'cost_recompute',
      description: '按「计费时代」重算已入库记录的费用（一次性补账）。用于价格调整或计价口径修正后宿主未及时重启、导致记录按旧口径入库的情况；默认只试算不落盘，传 apply: true 才写回。默认扫描**全部**明细（since=0），避免更早时代里标错口径的记录被漏掉。',
      parameters: {
        type: 'object',
        properties: {
          apply: { type: 'boolean', description: '是否把重算结果写回（默认 false，仅试算）' },
          since: { type: 'string', description: '重算起始时刻（ISO 字符串或 epoch ms）；默认 0 = 全时段扫描（补账幂等，建议保持默认）' },
        },
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, v) => {
          const scope = v.since === 0
            ? '全时段'
            : ('自 ' + new Date(v.since + 28800000).toISOString().replace('T', ' ').slice(0, 16).replace(/-/g, '/') + ' 北京起 · era=' + v.era)
          const lines = [
            '费用重算（' + scope + '）',
            '扫描 ' + v.scanned + ' 条，需修正 ' + v.changed + ' 条' + (v.estimatedFlips ? '（其中 ' + v.estimatedFlips + ' 条仅订正「估算」标记，金额不变）' : ''),
            '合计：¥' + v.oldCost + ' → ¥' + v.newCost + '（' + (v.delta >= 0 ? '+' : '') + v.delta + '）',
          ]
          for (const m of (v.byModel || []).slice(0, 8)) {
            lines.push('  ' + m.from + (m.to !== m.from ? ' → ' + m.to : '') + '：' + m.calls + ' 次 · ¥' + m.oldCost + ' → ¥' + m.newCost + (m.estimatedFlips ? ' · 标记订正 ' + m.estimatedFlips + ' 条' : ''))
          }
          lines.push(v.note)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: async (args) => recomputeCosts(args),
    })

    ctx.tools.register({
      name: 'cost_peak',
      description: '查询当前 DeepSeek 峰谷计价档位与下次切换倒计时（北京时间：高峰时段为周一至周五 9:00-12:00、14:00-18:00，其余为闲时，周末全天闲时）。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, v) => {
          const p = v.phase
          const phaseText = !p ? '未知' : p.weekend ? '周末全天闲时（全谷价）' : p.inPeak ? '高峰时段（按峰时价）' : '闲时时段（按谷时价）'
          const nextText = p ? new Date(p.nextAtMs + 28800000).toISOString().replace('T', ' ').slice(0, 16).replace(/-/g, '/') + ' 转' + (p.nextIntoPeak ? '峰' : '谷') : '未知'
          return [{ type: 'text', text: '峰谷计价：' + (v.enabled ? '已启用' : '已停用') + '（' + v.peakWindows + '）\n当前档位：' + phaseText + '\n下次切换：' + nextText + (v.effective ? '' : '（峰谷未生效，按平价计费）') }]
        },
      },
      execute: async () => peakSnapshot(),
    })

    ctx.tools.register({
      name: 'cost_stats',
      description: '查询模型调用花费与用量统计（人民币 CNY 计价）。默认只看本机（scope=local）；传 scope=cloud 或 both 可纳入云端多机汇总（需已配置云端同步）。按量计费与订阅制套餐（等效费用，仅供参考）分开统计。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '统计最近 N 天；0 表示全部。默认 7。' },
          scope: { type: 'string', enum: ['local', 'cloud', 'both'], description: 'local=仅本机（默认）；cloud=仅云端汇总（含其他设备）；both=两者并列' },
        },
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, v) => {
          const lines = ['花费统计（' + (v.days === 0 ? '全部' : '近 ' + v.days + ' 天') + '）']
          if (v.local) {
            lines.push('【本机】按量消费：¥' + v.local.realTotal + '（高峰 ¥' + v.local.peakCost + ' · 闲时 ¥' + v.local.offCost
              + (v.local.flatCost > 0 ? ' · 平峰 ¥' + v.local.flatCost : '') + '）· 请求 ' + v.local.realCalls + ' 次 · Tokens ' + v.local.realTokens)
            lines.push('【本机】订阅套餐：请求 ' + v.local.subCalls + ' 次 · Tokens ' + v.local.subTokens + ' · 等效 ¥' + v.local.subEquivalent + '（订阅已覆盖，仅供参考）')
          }
          if (v.cloud && v.cloud.ok) {
            lines.push('【云端汇总】按量消费：¥' + v.cloud.realCost + ' · 请求 ' + v.cloud.realCalls + ' 次 · Tokens ' + v.cloud.realTokens
              + '（' + (v.cloud.devices || []).map((d) => d.name).join(' / ') + '）')
            if (v.cloud.sources && v.cloud.sources.length) {
              lines.push('【云端汇总】按 Agent：' + v.cloud.sources.map((s) => s.source + ' ¥' + s.cost).join(' · '))
            }
          } else if (v.cloud && !v.cloud.ok) {
            lines.push('【云端汇总】不可用：' + (v.cloud.error || '未配置'))
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: async (args) => {
        const a = args || {}
        const days = typeof a.days === 'number' ? a.days : 7
        const scope = a.scope === 'cloud' || a.scope === 'both' ? a.scope : 'local'
        const out = { ok: true, days, scope }
        if (scope === 'local' || scope === 'both') {
          const d = buildDashboard({ days })
          out.local = {
            realTotal: d.realCost, realCalls: d.realCalls, realTokens: d.realTokens,
            peakCost: d.peakCost, offCost: d.offCost, flatCost: d.flatCost,
            subEquivalent: d.subEquivalent, subCalls: d.subCalls, subTokens: d.subTokens,
          }
          // 兼容旧字段（保持既有输出不变）
          Object.assign(out, out.local)
        }
        if (scope === 'cloud' || scope === 'both') {
          const c = await fetchCloud({ route: 'overview', range: days === 0 ? 'all' : '7d', days })
          out.cloud = c.ok === false
            ? { ok: false, error: c.error || '云端不可用' }
            : {
              ok: true,
              realCost: c.summary.realCost, realCalls: c.summary.realCalls, realTokens: c.summary.realTokens,
              subEquivalent: c.summary.subEquivalent, subCalls: c.summary.subCalls,
              peakCost: c.summary.peakCost, offCost: c.summary.offCost, flatCost: c.summary.flatCost,
              devices: c.devices, sources: c.sources, asOf: c.asOf,
            }
        }
        return out
      },
    })

    ctx.tools.register({
      name: 'cost_sync',
      description: '云端同步（多机汇总）：查看状态、立即同步、测试连接、修改配置。默认仅上报本机用量到自建云端服务，不涉及任何回写。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'now', 'test', 'config'], description: 'status=查看状态（默认）；now=立即同步；test=测试连接；config=修改配置' },
          full: { type: 'boolean', description: 'action=now 时是否全量补传（重置水位后重发）' },
          config: { type: 'object', description: 'action=config 时的配置片段，如 { cloudEnabled: true, cloudUrl: "https://...", cloudToken: "..." }', additionalProperties: true },
        },
        additionalProperties: true,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, v) => {
          if (v.action === 'test') {
            return [{ type: 'text', text: v.ok ? ('云端连接正常：服务端 ' + v.serviceVersion + '（syncVer ' + SYNC_VERSION + '）' + (v.selfRegister ? ' · 允许自注册' : ' · 需后台建令牌')) : ('连接失败：' + v.error) }]
          }
          const st = v.status || v
          const lines = [
            '云端同步：' + (st.enabled ? '已启用' : '未启用') + (st.url ? '（' + st.url + '）' : ''),
            '设备：' + (st.deviceName || '未命名') + ' · ' + (st.deviceId || '未生成'),
            '令牌：' + (st.hasToken ? '已配置' : '未配置') + ' · 上次同步：' + (st.lastSyncAt ? new Date(st.lastSyncAt + 28800000).toISOString().replace('T', ' ').slice(0, 16).replace(/-/g, '/') + '（北京）' : '从未'),
            '待上报：' + st.pending + ' 条 · 已上报水位 seq=' + st.watermark + ' · 日汇总已同步 ' + st.rollupsSent + ' 项',
          ]
          if (st.lastError) lines.push('最近错误：' + st.lastError + (st.backoffMs ? '（退避 ' + Math.round(st.backoffMs / 1000) + 's）' : ''))
          if (st.needAuth) lines.push('⚠ 令牌无效：请在「设置 → 插件 → 插件配置 → 花费统计」更新共享引导令牌')
          if (v.action === 'now' && v.result) {
            lines.push('本次同步：新增 ' + (v.result.accepted || 0) + ' 条 · 去重 ' + (v.result.duplicates || 0) + ' 条 · 日汇总 ' + (v.result.rollups || 0) + ' 项' + (v.result.error ? ' · 失败：' + v.result.error : ''))
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: async (args) => {
        const a = args || {}
        const action = a.action || 'status'
        if (action === 'test') {
          const r = await syncEngine.testConnection()
          return Object.assign({ ok: r.ok === true, action, syncVer: SYNC_VERSION }, r)
        }
        if (action === 'now') {
          const result = await syncEngine.runOnce({ manual: true, full: a.full === true })
          return { ok: result.ok !== false || !result.error, action, result, status: syncEngine.status() }
        }
        if (action === 'config') {
          cloudConfig = normalizeCloudConfig(Object.assign({}, cloudConfig, a.config || {}))
          saveConfig()
          startSyncTimer()
          if (a.config && a.config.cloudEnabled) scheduleSync(800)
          return { ok: true, action, status: syncEngine.status() }
        }
        return { ok: true, action: 'status', status: syncEngine.status() }
      },
    })

    // ---------- lifecycle ----------
    loadRecords()
    loadConfig()
    const settingsOk = installSettingsSection()
    if (!settingsOk) {
      // settings 是可选服务（宿主未组合时不报错、不阻断启动），但不能像 1.8.0 那样只探一次：
      // 它晚于本插件就绪时，那一次 ctx.get('settings') 必然落空 → 命名空间永不注册 →
      // 「设置 → 插件 → 插件配置」里永远没有本插件的卡片。
      // 与 dsh-context 的 installSettings 同款写法：ctx.inject 等它就绪后再装，始终缺席则自然 inert。
      try {
        ctx.inject(['settings'], (sctx) => {
          const provider = sctx.get('settings') || sctx.settings
          if (installSettingsSection(provider, sctx)) publishSettings()
        })
      } catch (e) {
        startupLog('settings inject skipped: ' + String(e && e.message ? e.message : e))
      }
    }
    startSyncTimer()
    if (cloudConfig.cloudEnabled) scheduleSync(5000)
    ctx.effect(() => () => {
      try { writeRecords() } catch (e) {}
      if (syncTimer) { try { syncTimer() } catch (e) {} }
      if (syncDebounce) { try { syncDebounce() } catch (e) {} }
    }, 'cost-tracker: final flush')
    startupLog('cost tracker ready (static) · source=' + SYNC_SOURCE + ' syncVer=' + SYNC_VERSION
      + ' settings=' + (settingsOk ? 'yes' : 'no') + ' cloud=' + (cloudConfig.cloudEnabled ? 'on' : 'off'))
  },
}
