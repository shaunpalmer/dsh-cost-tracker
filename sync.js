// ============================================================
// DSH Cost Tracker - cloud sync engine
//
// Responsibilities:
// 1. Maintain local device identity and sync watermark state.
// 2. Compute content-hash deduplication keys compatible with the cloud API.
// 3. Build incremental detail and daily-rollup payloads.
// 4. Classify remote errors and back off without blocking local accounting.
//
// Cloud sync is optional and privacy-first. It is disabled by default,
// session identifiers are masked by default, and purpose metadata is omitted
// unless the user explicitly enables it.
// ============================================================
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Agent identifier used by the cloud dashboard. */
export const SOURCE = 'dsh'
export const SYNC_VERSION = 1
const US = '\u001f'
const DAY_MS = 86400000
const MAX_BATCH_BYTES = 900 * 1024

/**
 * Historical backfill algorithm version stored in sync state.
 * Version 2 advances the watermark only to the highest sequence actually sent
 * in the current batch, preventing older unsent records from being skipped.
 */
const BACKFILL_VER = 2

// ------------------------------------------------------------
// Shared device identity
// DSH_COST_HOME can override the directory when multiple environments should
// intentionally share one device identity.
// ------------------------------------------------------------
export function dataDir(env) {
  const e = env || process.env
  return e.DSH_COST_HOME && String(e.DSH_COST_HOME).trim()
    ? String(e.DSH_COST_HOME).trim()
    : join(homedir(), '.dsh-cost')
}

export function identityPath(env) { return join(dataDir(env), 'device.json') }
export function syncStatePath(storageDir) { return join(storageDir, 'cost-tracker-sync.json') }

function defaultMachineId(env) {
  const e = env || process.env
  const host = e.COMPUTERNAME || e.HOSTNAME || e.HOST || 'unknown-host'
  const user = e.USERNAME || e.USER || 'unknown-user'
  return createHash('sha256').update(host + '/' + user).digest('hex').slice(0, 16)
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function writePrivateJson(file, value) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Read or create the shared device identity.
 *
 * @param {{env?:object, dir?:string}} [opts]
 * @returns {{v:number, machineId:string, machineName:string, nameLocked:boolean}}
 */
export function loadIdentity(opts) {
  const env = (opts && opts.env) || process.env
  const dir = (opts && opts.dir) || dataDir(env)
  const file = join(dir, 'device.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.machineId) {
      return {
        v: 1,
        machineId: String(parsed.machineId),
        machineName: String(parsed.machineName || ''),
        nameLocked: parsed.nameLocked === true,
      }
    }
  } catch (e) { /* First run or damaged file: rebuild below. */ }

  const id = {
    v: 1,
    machineId: defaultMachineId(env),
    machineName: (env.COMPUTERNAME || env.HOSTNAME || 'DSH device'),
    nameLocked: false,
  }

  try {
    ensurePrivateDir(dir)
    writeFileSync(file, JSON.stringify(id, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (e) { /* Read-only environments continue with in-memory identity. */ }
  return id
}

export function saveIdentity(id, opts) {
  const env = (opts && opts.env) || process.env
  const dir = (opts && opts.dir) || dataDir(env)
  try {
    ensurePrivateDir(dir)
    writePrivateJson(join(dir, 'device.json'), id)
    return true
  } catch (e) {
    return false
  }
}

// ------------------------------------------------------------
// Deduplication keys
// ------------------------------------------------------------
function s(v) { return v === undefined || v === null ? '' : String(v).trim() }
function i(v) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 }
function cost6(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return '0'
  return String(Math.round(n * 1e6) / 1e6)
}

/** Canonical detail string used for cloud deduplication. */
export function detailCanonical(rec, resetEpoch) {
  const t = (rec && rec.tokens) || {}
  return [
    'detail', i(resetEpoch), i(rec && rec.ts),
    s(rec && rec.provider).toLowerCase(), s(rec && rec.model).toLowerCase(),
    s(rec && rec.sessionId), s(rec && rec.purpose),
    i(t.input), i(t.output), i(t.cacheRead), i(t.cacheWrite), i(t.reasoning),
    cost6(rec && rec.cost),
  ].join(US)
}

/** Canonical daily-rollup identity string. */
export function rollupCanonical(entry) {
  return [
    'rollup:' + s(entry && entry.dayKey),
    entry && (entry.subscription === true || entry.subscription === 1) ? '1' : '0',
    s(entry && entry.provider).toLowerCase(),
    s(entry && entry.model).toLowerCase(),
  ].join(US)
}

export function sha256hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex')
}

export function dedupKeyOf(rec, resetEpoch) {
  return sha256hex(detailCanonical(rec, resetEpoch))
}

export function rollupKeyOf(entry) {
  return sha256hex(rollupCanonical(entry))
}

// ------------------------------------------------------------
// Cloud configuration
// ------------------------------------------------------------
export function normalizeCloudConfig(raw) {
  const def = {
    cloudEnabled: false,
    cloudUrl: '',
    cloudToken: '',
    deviceName: '',
    deviceId: '',
    syncIntervalSec: 60,
    syncBatchSize: 500,
    maskSessionId: true,
    includePurpose: false,
    syncRollups: true,
    syncSinceDays: 180,
    cloudView: 'local',
    cloudPanelDevices: [],
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return def
  const url = typeof raw.cloudUrl === 'string' ? raw.cloudUrl.trim().replace(/\/+$/, '') : ''
  const validUrl = /^https?:\/\/[^\s]+$/i.test(url) ? url : ''
  const intIn = (v, lo, hi, fb) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fb)
  const view = raw.cloudView === 'local+cloud' || raw.cloudView === 'cloud' ? raw.cloudView : 'local'
  return {
    cloudEnabled: raw.cloudEnabled === true && !!validUrl,
    cloudUrl: validUrl,
    cloudToken: typeof raw.cloudToken === 'string' ? raw.cloudToken.trim().slice(0, 512) : '',
    deviceName: typeof raw.deviceName === 'string' ? raw.deviceName.trim().slice(0, 64) : '',
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId.trim().slice(0, 128) : '',
    syncIntervalSec: intIn(raw.syncIntervalSec, 15, 3600, def.syncIntervalSec),
    syncBatchSize: intIn(raw.syncBatchSize, 50, 2000, def.syncBatchSize),
    maskSessionId: raw.maskSessionId === undefined ? def.maskSessionId : raw.maskSessionId === true,
    includePurpose: raw.includePurpose === true,
    syncRollups: raw.syncRollups !== false,
    syncSinceDays: intIn(raw.syncSinceDays, 0, 3650, def.syncSinceDays),
    cloudView: view,
    cloudPanelDevices: Array.isArray(raw.cloudPanelDevices)
      ? raw.cloudPanelDevices.map((x) => String(x)).filter(Boolean).slice(0, 64)
      : [],
  }
}

// ------------------------------------------------------------
// Sync state
// ------------------------------------------------------------
export function defaultSyncState() {
  return {
    v: 1,
    deviceId: '',
    watermark: 0,
    lastSyncAt: 0,
    lastOkAt: 0,
    lastError: '',
    needAuth: false,
    backoffMs: 0,
    pendingFailures: 0,
    legacySent: false,
    backfillVer: 0,
    rollups: {},
    records: 0,
  }
}

export function readSyncState(storageDir) {
  try {
    const parsed = JSON.parse(readFileSync(syncStatePath(storageDir), 'utf8'))
    return Object.assign(defaultSyncState(), parsed && typeof parsed === 'object' ? parsed : {})
  } catch (e) {
    return defaultSyncState()
  }
}

export function writeSyncState(storageDir, state) {
  try {
    ensurePrivateDir(storageDir)
    writePrivateJson(syncStatePath(storageDir), state)
    return true
  } catch (e) {
    return false
  }
}

// ------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------
function classifyStatus(status, body) {
  if (status === 200 && body && body.ok) return { ok: true }
  const code = (body && body.code) || ''
  if (status === 401 || code === 'TOKEN_INVALID' || code === 'TOKEN_MISSING') {
    return { ok: false, code: 'TOKEN_INVALID', needAuth: true, message: 'Cloud token is invalid; update it in plugin settings.' }
  }
  if (status === 403) {
    return { ok: false, code, needAuth: false, message: (body && body.error) || 'Cloud access denied: the device is disabled or self-registration is unavailable.' }
  }
  if (status === 413 || code === 'BATCH_TOO_LARGE' || code === 'PAYLOAD_TOO_LARGE') {
    return { ok: false, code: 'TOO_LARGE', shrink: true, message: 'Sync batch is too large; retrying with a smaller batch.' }
  }
  if (status === 400) {
    return { ok: false, code, needAuth: false, fatal: true, message: (body && body.error) || 'Cloud rejected the request; check protocol compatibility.' }
  }
  if (status === 429) return { ok: false, code: 'RATE_LIMITED', retry: true, retryAfterMs: (body && body.retryAfterMs) || 60000, message: 'Cloud rate limit reached; retrying later.' }
  if (status >= 500 || status === 0) return { ok: false, code: 'SERVER', retry: true, message: (body && body.error) || 'Cloud service is temporarily unavailable.' }
  return { ok: false, code, needAuth: false, message: (body && body.error) || ('HTTP ' + status) }
}

// ------------------------------------------------------------
// Sync engine
// ------------------------------------------------------------
/**
 * @param {object} deps
 * @param {() => object} deps.getConfig Returns normalized plugin config.
 * @param {() => {details:Array, rollups:object, resetEpoch:number, storageDir:string, maxSeq:number}} deps.getSnapshot
 * @param {(patch:object) => void} [deps.setConfigField] Writes sync results/identity back to config.
 * @param {typeof fetch} [deps.fetchFn]
 * @param {() => number} [deps.now]
 * @param {(msg:string) => void} [deps.log]
 */
export function createSyncEngine(deps) {
  const getConfig = deps.getConfig
  const getSnapshot = deps.getSnapshot
  const setConfigField = deps.setConfigField || (() => {})
  const fetchFn = deps.fetchFn || globalThis.fetch
  const now = deps.now || (() => Date.now())
  const log = deps.log || (() => {})
  let identity = null
  let running = false

  function identityOf() {
    if (!identity) {
      const snap = safeSnapshot()
      const cfg = normalizeCloudConfig(getConfig())
      identity = loadIdentity({ dir: dataDir() })
      if (cfg.deviceName && !identity.nameLocked && identity.machineName !== cfg.deviceName) {
        identity.machineName = cfg.deviceName
        saveIdentity(identity)
      }
    }
    return identity
  }

  function safeSnapshot() {
    try { return getSnapshot() || {} } catch (e) { return {} }
  }

  function state() {
    const snap = safeSnapshot()
    return readSyncState(snap.storageDir || process.cwd())
  }

  function saveState(next) {
    const snap = safeSnapshot()
    return writeSyncState(snap.storageDir || process.cwd(), next)
  }

  function headers(token) {
    return {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
    }
  }

  /** Build the next detail-record payload. */
  function buildRecordsPayload(cfg, st, limitOverride) {
    const snap = safeSnapshot()
    const details = Array.isArray(snap.details) ? snap.details : []
    const resetEpoch = Number(snap.resetEpoch) || 0
    const limit = limitOverride || cfg.syncBatchSize
    const cutoff = cfg.syncSinceDays > 0 ? now() - cfg.syncSinceDays * DAY_MS : 0
    const out = []
    let bytes = 0

    for (let k = 0; k < details.length; k += 1) {
      const r = details[k]
      if (!r || typeof r.ts !== 'number') continue
      const seq = Number.isFinite(r.seq) ? r.seq : 0
      if (seq <= st.watermark && st.watermark > 0) continue
      if (cutoff && r.ts < cutoff) continue
      const rec = {
        seq: seq || undefined,
        ts: r.ts,
        provider: r.provider,
        model: r.model,
        sessionId: cfg.maskSessionId && r.sessionId ? sha256hex(String(r.sessionId)).slice(0, 16) : (r.sessionId || ''),
        purpose: cfg.includePurpose ? (r.purpose || '') : '',
        tokens: {
          input: Number(r.tokens && r.tokens.input) || 0,
          output: Number(r.tokens && r.tokens.output) || 0,
          cacheRead: Number(r.tokens && r.tokens.cacheRead) || 0,
          cacheWrite: Number(r.tokens && r.tokens.cacheWrite) || 0,
          reasoning: Number(r.tokens && r.tokens.reasoning) || 0,
        },
        cost: Number(r.cost) || 0,
        estimated: r.estimated === true,
        subscription: r.subscription === true,
        period: r.period || 'flat',
      }
      rec.dedupKey = dedupKeyOf(r, resetEpoch)
      const size = JSON.stringify(rec).length
      if (out.length > 0 && (out.length >= limit || bytes + size > MAX_BATCH_BYTES)) break
      out.push(rec)
      bytes += size
      if (out.length >= limit) break
    }

    return {
      records: out,
      maxClientSeq: out.length ? Math.max(...out.map((r) => Number(r.seq) || 0)) : 0,
      resetEpoch,
    }
  }

  /** Build daily-rollup snapshots that have changed since the last sync. */
  function buildRollupsPayload(cfg, st) {
    const snap = safeSnapshot()
    const rollups = snap.rollups || {}
    const out = []
    const sent = Object.assign({}, st.rollups || {})
    for (const day of Object.keys(rollups)) {
      for (const mk of Object.keys(rollups[day])) {
        const e = rollups[day][mk]
        if (!e) continue
        const key = rollupKeyOf({ dayKey: day, provider: e.provider, model: e.model, subscription: e.subscription })
        const prev = sent[key]
        if (prev && Number(prev.calls) >= Number(e.calls) && Number(prev.cost) >= Number(e.cost)) continue
        out.push({
          key,
          snapshot: {
            dayKey: day,
            provider: e.provider,
            model: e.model,
            subscription: e.subscription === true,
            calls: Number(e.calls) || 0,
            tokens: {
              input: Number(e.input) || 0,
              output: Number(e.output) || 0,
              cacheRead: Number(e.cacheRead) || 0,
              cacheWrite: Number(e.cacheWrite) || 0,
              reasoning: Number(e.reasoning) || 0,
            },
            cost: Number(e.cost) || 0,
            peak: Number(e.peak) || 0,
            off: Number(e.off) || 0,
            flat: Number(e.flat) || 0,
            absorbed: Array.isArray(e.absorbed) ? e.absorbed.slice(0, 5000) : [],
          },
        })
        if (out.length >= 200) break
      }
      if (out.length >= 200) break
    }
    return out
  }

  async function postJson(url, token, payload, timeoutMs) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs || 15000)
    try {
      const res = await fetchFn(url, { method: 'POST', headers: headers(token), body: JSON.stringify(payload), signal: ac.signal })
      let body = null
      try { body = await res.json() } catch (e) { body = null }
      return { status: res.status, body }
    } catch (e) {
      const transportError = String((e && e.message) || e)
      return {
        status: 0,
        body: { ok: false, error: 'Cloud service is temporarily unavailable: ' + transportError },
        error: transportError,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function ensureDevice(cfg, st) {
    const id = identityOf()
    const deviceId = cfg.deviceId || id.machineId
    if (st.deviceId && !cfg.deviceId) return st.deviceId
    return deviceId
  }

  async function runOnce(opts) {
    const manual = !!(opts && opts.manual)
    const full = !!(opts && opts.full)
    const cfg = normalizeCloudConfig(getConfig())
    const result = { ok: false, skipped: true, accepted: 0, duplicates: 0, rollups: 0, error: '', needAuth: false, at: now() }
    if (!cfg.cloudEnabled || !cfg.cloudUrl) {
      result.error = 'Cloud sync is disabled or no service URL is configured.'
      return result
    }
    if (!cfg.cloudToken) {
      result.error = 'No cloud token is configured.'
      result.needAuth = true
      return result
    }
    if (running) {
      result.error = 'A previous sync is still running.'
      return result
    }

    running = true
    try {
      const st = readSyncState(safeSnapshot().storageDir || process.cwd())
      if (full) { st.watermark = 0; st.legacySent = false; st.backfillVer = 0 }
      const backfill = Number(st.backfillVer) !== BACKFILL_VER
      if (backfill) st.watermark = 0
      st.deviceId = await ensureDevice(cfg, st)
      if (!identityOf().nameLocked && cfg.deviceName) {
        identity.machineName = cfg.deviceName
        saveIdentity(identity)
      }
      const id = identityOf()
      const base = cfg.cloudUrl

      let pending = buildRecordsPayload(cfg, st, cfg.syncBatchSize)
      let sentRecords = 0
      let round = 0
      while (pending.records.length && round < 40) {
        round += 1
        const payload = {
          syncVer: SYNC_VERSION,
          source: SOURCE,
          agentInstance: '',
          agent: { name: 'DSH', version: process.env.DSH_VERSION || '', pluginVersion: PLUGIN_VERSION },
          deviceId: st.deviceId,
          deviceName: id.machineName || cfg.deviceName || '',
          resetEpoch: pending.resetEpoch,
          maxClientSeq: pending.maxClientSeq,
          sentAt: now(),
          batchUid: randomUUID(),
          records: pending.records,
        }
        const r = await postJson(base + '/api/v1/ingest/records', cfg.cloudToken, payload)
        const cls = classifyStatus(r.status, r.body)
        if (!cls.ok) {
          if (cls.shrink && pending.records.length > 1) {
            const half = Math.max(1, Math.floor(pending.records.length / 2))
            pending = buildRecordsPayload(cfg, st, half)
            continue
          }
          throw Object.assign(new Error(cls.message || 'Cloud upload failed.'), { needAuth: cls.needAuth, retryAfterMs: cls.retryAfterMs, fatal: cls.fatal })
        }
        const accepted = Number(r.body.accepted) || 0
        const dup = Number(r.body.duplicates) || 0
        const updated = Number(r.body.updated) || 0
        const invalid = Number(r.body.invalid) || 0
        sentRecords += accepted + dup + updated
        result.accepted += accepted
        result.duplicates += dup
        result.updated = (result.updated || 0) + updated
        result.invalid = (result.invalid || 0) + invalid
        if (accepted + dup + updated > 0) {
          if (pending.maxClientSeq > st.watermark) st.watermark = pending.maxClientSeq
        } else if (invalid > 0) {
          throw Object.assign(new Error('Cloud rejected all ' + invalid + ' records in this batch.'), { fatal: true })
        }
        const next = buildRecordsPayload(cfg, st, cfg.syncBatchSize)
        if (!next.records.length || next.maxClientSeq <= pending.maxClientSeq) break
        pending = next
      }
      result.sentRecords = sentRecords
      st.legacySent = true
      st.backfillVer = BACKFILL_VER

      if (cfg.syncRollups) {
        const snaps = buildRollupsPayload(cfg, st)
        for (let k = 0; k < snaps.length; k += 100) {
          const chunk = snaps.slice(k, k + 100)
          const payload = {
            syncVer: SYNC_VERSION,
            source: SOURCE,
            agentInstance: '',
            agent: { name: 'DSH', pluginVersion: PLUGIN_VERSION },
            deviceId: st.deviceId,
            deviceName: id.machineName || '',
            sentAt: now(),
            batchUid: randomUUID(),
            snapshots: chunk.map((x) => x.snapshot),
          }
          const r = await postJson(base + '/api/v1/ingest/rollups', cfg.cloudToken, payload)
          const cls = classifyStatus(r.status, r.body)
          if (!cls.ok) throw Object.assign(new Error(cls.message || 'Rollup upload failed.'), { needAuth: cls.needAuth, retryAfterMs: cls.retryAfterMs, fatal: cls.fatal })
          result.rollups += Number(r.body.rollupsUpserted) || 0
          for (const item of chunk) {
            const at = r.body && r.body.watermark ? r.body.watermark.lastAcceptedAt : now()
            st.rollups[item.key] = { calls: item.snapshot.calls, cost: item.snapshot.cost, at }
          }
        }
      }

      st.lastSyncAt = now()
      st.lastOkAt = now()
      st.lastError = ''
      st.needAuth = false
      st.backoffMs = 0
      st.pendingFailures = 0
      st.records = (st.records || 0) + result.accepted
      saveState(st)
      setConfigField({ lastSyncAt: st.lastSyncAt, lastSyncOk: true, lastSyncError: '', lastSyncAccepted: result.accepted })
      result.ok = true
      result.skipped = false
      result.watermark = st.watermark
      log('sync ok: accepted=' + result.accepted + ' dup=' + result.duplicates + ' rollups=' + result.rollups + ' watermark=' + st.watermark)
      return result
    } catch (e) {
      const st = readSyncState(safeSnapshot().storageDir || process.cwd())
      st.pendingFailures = (st.pendingFailures || 0) + 1
      st.lastError = String((e && e.message) || e)
      st.needAuth = e && e.needAuth === true
      const retryAfter = Number(e && e.retryAfterMs) || 0
      st.backoffMs = retryAfter || Math.min(300000, 5000 * Math.pow(2, Math.min(6, st.pendingFailures - 1)))
      st.lastSyncAt = now()
      saveState(st)
      setConfigField({ lastSyncAt: st.lastSyncAt, lastSyncOk: false, lastSyncError: st.lastError, needAuth: st.needAuth })
      result.error = st.lastError
      result.needAuth = st.needAuth
      result.backoffMs = st.backoffMs
      log('sync failed: ' + st.lastError)
      return result
    } finally {
      running = false
    }
  }

  async function testConnection(cfgOverride) {
    const cfg = normalizeCloudConfig(cfgOverride || getConfig())
    if (!cfg.cloudUrl) return { ok: false, error: 'No service URL is configured.' }
    try {
      const res = await fetchFn(cfg.cloudUrl + '/api/v1/health', { method: 'GET' })
      const body = await res.json().catch(() => null)
      if (!body || body.ok !== true) return { ok: false, error: 'HTTP ' + res.status + ': service is not ready.' }
      if (Number(body.syncVer) !== SYNC_VERSION) {
        return { ok: false, error: 'Protocol version mismatch: plugin syncVer=' + SYNC_VERSION + ', server syncVer=' + body.syncVer }
      }
      if (Number(body.minSyncVer) > SYNC_VERSION) {
        return { ok: false, error: 'Server requires syncVer >= ' + body.minSyncVer + '; update the plugin.' }
      }
      return {
        ok: true,
        serviceVersion: String(body.serviceVersion || ''),
        selfRegister: !!(body.caps && body.caps.selfRegister),
        groupBy: (body.caps && body.caps.groupBy) || [],
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  function status() {
    const cfg = normalizeCloudConfig(getConfig())
    const st = readSyncState(safeSnapshot().storageDir || process.cwd())
    const snap = safeSnapshot()
    const id = identityOf()
    const pending = buildRecordsPayload(cfg, st, cfg.syncBatchSize)
    return {
      enabled: cfg.cloudEnabled,
      url: cfg.cloudUrl,
      hasToken: !!cfg.cloudToken,
      deviceId: cfg.deviceId || id.machineId,
      deviceName: cfg.deviceName || id.machineName,
      watermark: st.watermark,
      maxSeq: Number(snap.maxSeq) || 0,
      pending: pending.records.length,
      lastSyncAt: st.lastSyncAt,
      lastOkAt: st.lastOkAt,
      lastError: st.lastError,
      needAuth: st.needAuth,
      backoffMs: st.backoffMs,
      failures: st.pendingFailures,
      rollupsSent: Object.keys(st.rollups || {}).length,
      intervalSec: cfg.syncIntervalSec,
      view: cfg.cloudView,
      viewCloudMode: cfg.cloudView === 'cloud' ? 'cloud' : cfg.cloudView === 'local+cloud' ? 'cloud-rest' : 'cloud-others',
      maskSessionId: cfg.maskSessionId,
      includePurpose: cfg.includePurpose,
      syncSinceDays: cfg.syncSinceDays,
      dataDir: dataDir(),
      identityFile: identityPath(),
    }
  }

  return { runOnce, status, testConnection, loadIdentity: identityOf, _buildRecordsPayload: buildRecordsPayload, _buildRollupsPayload: buildRollupsPayload }
}

/** Plugin version injected by index.js; defaults to dev when unknown. */
export let PLUGIN_VERSION = 'dev'
export function setPluginVersion(v) { PLUGIN_VERSION = String(v || 'dev') }
