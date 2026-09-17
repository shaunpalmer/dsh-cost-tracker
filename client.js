// Project Studios English client for dsh-cost-tracker.
//
// This hardened client intentionally keeps the UI small: current spend,
// month/all-time totals, requests, tokens, DeepSeek balance, recent records,
// CSV export, and the live conversation cost.

window.__ModuleLoader__.load({
  id: '@shaunpalmer/dsh-cost-tracker',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const e = React.createElement
    const useEffect = React.useEffect
    const useState = React.useState

    const FX_ENDPOINT = 'https://api.frankfurter.dev/v2/rate/cny/nzd'
    const FX_CACHE_KEY = 'project-studios-cost-tracker:fx:cny-nzd:v1'
    const FX_CACHE_TTL_MS = 24 * 60 * 60 * 1000

    /**
     * Call one host API route exposed by the accounting engine.
     *
     * @param {string} method Cost tracker route name.
     * @param {object} args JSON request payload.
     * @returns {Promise<object>} Parsed host response.
     */
    async function apiCall(method, args = {}) {
      const response = await fetch('/api/cost-tracker/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      })

      if (!response.ok) {
        throw new Error('Cost tracker request failed with HTTP ' + response.status)
      }

      return response.json()
    }

    function formatInteger(value) {
      return Math.round(Number(value) || 0).toLocaleString('en-NZ')
    }

    function formatCompact(value) {
      const number = Number(value) || 0
      if (number >= 1_000_000) return (number / 1_000_000).toFixed(1) + 'M'
      if (number >= 1_000) return (number / 1_000).toFixed(1) + 'K'
      return String(Math.round(number))
    }

    function formatMoney(value) {
      const number = Number(value) || 0
      return number >= 1 ? number.toFixed(2) : number.toFixed(4)
    }

    function isValidFxRate(value) {
      const rate = Number(value)
      return Number.isFinite(rate) && rate > 0
    }

    function formatNzd(value) {
      const number = Number(value) || 0
      const decimals = Math.abs(number) >= 1 ? 2 : 4
      return 'NZ$' + number.toLocaleString('en-NZ', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
    }

    function cnyLabel(value) {
      return '¥' + formatMoney(value) + ' CNY'
    }

    function moneyLabels(value, fxRate) {
      const cny = Number(value) || 0
      if (!isValidFxRate(fxRate)) {
        return { primary: cnyLabel(cny), secondary: '' }
      }

      return {
        primary: formatNzd(cny * Number(fxRate)),
        secondary: cnyLabel(cny),
      }
    }

    function readFxCache() {
      try {
        const raw = window.localStorage && window.localStorage.getItem(FX_CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!isValidFxRate(parsed.rate) || !Number.isFinite(Number(parsed.fetchedAt))) return null
        return {
          rate: Number(parsed.rate),
          fetchedAt: Number(parsed.fetchedAt),
          date: typeof parsed.date === 'string' ? parsed.date : '',
        }
      } catch (_) {
        return null
      }
    }

    function writeFxCache(value) {
      try {
        if (!window.localStorage) return
        window.localStorage.setItem(FX_CACHE_KEY, JSON.stringify(value))
      } catch (_) {
        // Display conversion must never make the tracker unusable.
      }
    }

    async function loadCnyNzdRate() {
      const cached = readFxCache()
      const now = Date.now()
      if (cached && now - cached.fetchedAt < FX_CACHE_TTL_MS) {
        return { ...cached, stale: false, source: 'cache' }
      }

      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timeout = controller ? setTimeout(() => controller.abort(), 4000) : null

      try {
        const response = await fetch(FX_ENDPOINT, {
          method: 'GET',
          headers: { accept: 'application/json' },
          ...(controller ? { signal: controller.signal } : {}),
        })
        if (!response.ok) throw new Error('FX HTTP ' + response.status)
        const payload = await response.json()
        const rate = Number(payload && payload.rate)
        if (!isValidFxRate(rate)) throw new Error('FX response did not contain a valid rate')

        const value = {
          rate,
          fetchedAt: now,
          date: payload && typeof payload.date === 'string' ? payload.date : '',
        }
        writeFxCache(value)
        return { ...value, stale: false, source: 'frankfurter' }
      } catch (_) {
        if (cached) return { ...cached, stale: true, source: 'stale-cache' }
        return { rate: null, fetchedAt: 0, date: '', stale: false, source: 'unavailable' }
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }

    function installStyles(ctx) {
      const style = document.createElement('style')
      style.dataset.pluginCss = 'project-studios-cost-tracker'
      style.textContent = `
.ps-cost { padding: 6px 2px 28px; color: var(--dsw-alias-label-primary, #171a1f); font-size: 13px; }
.ps-cost * { box-sizing: border-box; }
.ps-cost-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.ps-cost-title { font-size: 17px; font-weight: 650; }
.ps-cost-note { color: var(--dsw-alias-label-secondary, #667085); font-size: 12px; }
.ps-cost-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
.ps-cost-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 12px 0; }
.ps-cost-card, .ps-cost-panel { border: 1px solid var(--dsw-alias-border-l1, #e5e7eb); background: var(--dsw-alias-bg-layer-1, #fff); border-radius: 10px; }
.ps-cost-card { padding: 13px 14px; }
.ps-cost-label { color: var(--dsw-alias-label-secondary, #667085); font-size: 12px; }
.ps-cost-value { margin-top: 5px; font-size: 23px; font-weight: 650; font-variant-numeric: tabular-nums; }
.ps-cost-sub { margin-top: 5px; color: var(--dsw-alias-label-secondary, #667085); font-size: 11px; }
.ps-cost-panel { padding: 13px 14px; margin-top: 12px; }
.ps-cost-panel-title { font-size: 14px; font-weight: 650; margin-bottom: 8px; }
.ps-cost-btn, .ps-cost-select { border: 1px solid var(--dsw-alias-border-l2, #d1d5db); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; border-radius: 6px; padding: 5px 9px; font-size: 12px; }
.ps-cost-btn { cursor: pointer; }
.ps-cost-btn:disabled { cursor: default; opacity: .55; }
.ps-cost-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ps-cost-table th, .ps-cost-table td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, #edf0f2); }
.ps-cost-table th { color: var(--dsw-alias-label-secondary, #667085); font-weight: 550; }
.ps-cost-error { color: var(--dsw-alias-state-error-primary, #dc2626); font-size: 12px; }
.ps-cost-session { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border: 1px solid var(--dsw-alias-border-l2, #d1d5db); border-radius: 999px; font-size: 12px; line-height: 1.25; }
.ps-cost-session strong { font-variant-numeric: tabular-nums; }
`
      document.head.appendChild(style)

      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => () => style.remove(), 'project-studios-cost-tracker: styles')
      }
    }

    function card(title, value, subtext) {
      return e('div', { className: 'ps-cost-card' },
        e('div', { className: 'ps-cost-label' }, title),
        e('div', { className: 'ps-cost-value' }, value),
        subtext ? e('div', { className: 'ps-cost-sub' }, subtext) : null,
      )
    }

    function Dashboard() {
      const [days, setDays] = useState(7)
      const [dashboard, setDashboard] = useState(null)
      const [balance, setBalance] = useState(null)
      const [fx, setFx] = useState({ rate: null, date: '', stale: false, source: 'loading' })
      const [message, setMessage] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      async function load() {
        setBusy(true)
        setError('')
        try {
          const [dashResult, balanceResult] = await Promise.all([
            apiCall('dashboard', { days }),
            apiCall('balance', {}).catch((balanceError) => ({ ok: false, error: String(balanceError.message || balanceError) })),
          ])

          if (!dashResult || dashResult.ok === false) {
            throw new Error((dashResult && dashResult.error) || 'Dashboard data is unavailable.')
          }

          setDashboard(dashResult)
          setBalance(balanceResult)
        } catch (loadError) {
          setError(String(loadError && loadError.message ? loadError.message : loadError))
        } finally {
          setBusy(false)
        }
      }

      useEffect(() => { load() }, [days])
      useEffect(() => {
        let active = true
        loadCnyNzdRate().then((result) => {
          if (active) setFx(result)
        })
        return () => { active = false }
      }, [])

      async function exportCsv() {
        setBusy(true)
        setMessage('Exporting...')
        try {
          const result = await apiCall('export', {})
          if (!result || result.ok === false) throw new Error((result && result.error) || 'Export failed.')
          setMessage('Exported ' + formatInteger(result.count) + ' records to ' + result.path)
        } catch (exportError) {
          setMessage('Export failed: ' + String(exportError && exportError.message ? exportError.message : exportError))
        } finally {
          setBusy(false)
        }
      }

      const today = (dashboard && dashboard.today) || {}
      const month = (dashboard && dashboard.month) || {}
      const all = (dashboard && dashboard.all) || {}
      const recent = dashboard && Array.isArray(dashboard.recent) ? dashboard.recent : []

      const todayMoney = moneyLabels(today.real, fx.rate)
      const monthMoney = moneyLabels(month.real, fx.rate)
      const allMoney = moneyLabels(all.real, fx.rate)

      let balanceValue = '—'
      let balanceSub = 'Balance lookup unavailable'
      if (balance && balance.ok) {
        const balanceMoney = moneyLabels(balance.total, fx.rate)
        balanceValue = balanceMoney.primary
        balanceSub = (balance.available ? 'Available' : 'Unavailable') + (balanceMoney.secondary ? ' · ' + balanceMoney.secondary : '')
      } else if (balance && balance.error) {
        balanceSub = String(balance.error)
      }

      const requestCount = (Number(all.calls) || 0) + (Number(all.subCalls) || 0)
      const tokenCount = (Number(all.tokens) || 0) + (Number(all.subTokens) || 0)
      const fxNote = isValidFxRate(fx.rate)
        ? 'NZD display uses a cached daily CNY→NZD reference rate from Frankfurter' + (fx.date ? ' (' + fx.date + ')' : '') + (fx.stale ? ' — cached rate' : '') + '. CNY remains canonical.'
        : 'CNY remains canonical. NZD reference rate is unavailable, so CNY is shown.'

      const allSpendSub = Number(all.sub) > 0
        ? 'Subscription equivalent: ' + moneyLabels(all.sub, fx.rate).primary + (isValidFxRate(fx.rate) ? ' · ' + cnyLabel(all.sub) : '')
        : 'Metered API spend'

      return e('div', { className: 'ps-cost' },
        e('div', { className: 'ps-cost-head' },
          e('div', null,
            e('div', { className: 'ps-cost-title' }, 'Cost Tracker'),
            e('div', { className: 'ps-cost-note' }, fxNote),
          ),
        ),
        e('div', { className: 'ps-cost-actions' },
          e('select', {
            className: 'ps-cost-select',
            value: String(days),
            onChange: (event) => setDays(Number(event.target.value)),
          },
          e('option', { value: '7' }, 'Last 7 days'),
          e('option', { value: '14' }, 'Last 14 days'),
          e('option', { value: '30' }, 'Last 30 days'),
          e('option', { value: '0' }, 'All history')),
          e('button', { className: 'ps-cost-btn', onClick: load, disabled: busy }, busy ? 'Refreshing...' : 'Refresh'),
          e('button', { className: 'ps-cost-btn', onClick: exportCsv, disabled: busy }, 'Export CSV'),
          message ? e('span', { className: 'ps-cost-note' }, message) : null,
        ),
        error ? e('div', { className: 'ps-cost-error' }, error) : null,
        e('div', { className: 'ps-cost-grid' },
          card('Today', todayMoney.primary, (todayMoney.secondary ? todayMoney.secondary + ' · ' : '') + formatInteger(today.calls) + ' metered requests'),
          card('This month', monthMoney.primary, (monthMoney.secondary ? monthMoney.secondary + ' · ' : '') + formatCompact(month.tokens) + ' metered tokens'),
          card('All-time spend', allMoney.primary, (allMoney.secondary ? allMoney.secondary + ' · ' : '') + allSpendSub),
          card('API requests', formatInteger(requestCount), 'Metered + subscription requests'),
          card('Tokens', formatInteger(tokenCount), 'Metered + subscription tokens'),
          card('DeepSeek balance', balanceValue, balanceSub),
        ),
        e('div', { className: 'ps-cost-panel' },
          e('div', { className: 'ps-cost-panel-title' }, 'Recent records'),
          e('div', { style: { overflowX: 'auto' } },
            e('table', { className: 'ps-cost-table' },
              e('thead', null,
                e('tr', null,
                  e('th', null, 'Time'),
                  e('th', null, 'Provider / model'),
                  e('th', null, 'Tokens'),
                  e('th', null, 'Cost'),
                ),
              ),
              e('tbody', null,
                recent.length
                  ? recent.map((record, index) => {
                    const recordMoney = moneyLabels(record.cost, fx.rate)
                    return e('tr', { key: String(record.ts || index) + '-' + index },
                      e('td', null, record.time || ''),
                      e('td', null, String(record.provider || '') + '/' + String(record.model || '')),
                      e('td', null, formatInteger((Number(record.input) || 0) + (Number(record.cacheRead) || 0) + (Number(record.cacheWrite) || 0) + (Number(record.output) || 0))),
                      e('td', null,
                        e('div', null, recordMoney.primary),
                        recordMoney.secondary ? e('div', { className: 'ps-cost-sub' }, recordMoney.secondary) : null,
                      ),
                    )
                  })
                  : e('tr', null, e('td', { colSpan: 4, className: 'ps-cost-note' }, 'No cost records yet.')),
              ),
            ),
          ),
        ),
      )
    }

    function StatusLine(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [summary, setSummary] = useState(null)
      const [fx, setFx] = useState({ rate: null, date: '', stale: false, source: 'loading' })

      useEffect(() => {
        let active = true

        async function refresh() {
          try {
            const result = await apiCall('summary', { sessionId })
            if (active && result) setSummary(result)
          } catch (_) {
            // The conversation composer should remain usable if metering fails.
          }
        }

        refresh()
        loadCnyNzdRate().then((result) => {
          if (active) setFx(result)
        })
        const interval = setInterval(refresh, 30_000)
        return () => {
          active = false
          clearInterval(interval)
        }
      }, [sessionId])

      if (!summary) return null

      const metered = Number(summary.sessionCost) || 0
      const subscription = Number(summary.sessionSub) || 0
      const meteredMoney = moneyLabels(metered, fx.rate)
      const subscriptionMoney = moneyLabels(subscription, fx.rate)
      const subtext = subscription > 0 ? ' + subscription equivalent ' + subscriptionMoney.primary : ''
      const cnyText = meteredMoney.secondary ? ' (' + meteredMoney.secondary + ')' : ''

      return e('span', { className: 'ps-cost-session', title: 'Current conversation cost; CNY is the canonical stored currency' },
        e('span', null, 'Session'),
        e('strong', null, meteredMoney.primary),
        cnyText ? e('span', { className: 'ps-cost-note' }, cnyText) : null,
        subtext ? e('span', { className: 'ps-cost-note' }, subtext) : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      installStyles(ctx)
      const slots = ctx.get('slots')
      if (!slots) return

      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'cost-dashboard', order: 30, label: 'Cost Tracker' },
        () => e(Dashboard),
      ))

      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'cost', order: 1 },
        (props) => e(StatusLine, props || {}),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})