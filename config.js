// ============================================================
// DSH Cost Tracker - configuration layer (pure logic, independently testable)
//
// Two groups of settings share one file:
//   $DSH_HOME/storages/cost-tracker-config.json
//
// Peak/off-peak pricing settings:
//   peakEnabled        Enable DeepSeek time-of-day pricing.
//   peakNotice         Show the peak-period notice bar.
//   peakStyle          compact or classic 24-hour dial.
//   peakShowTickLabels Show time labels on the classic dial.
//   peakCompactStack   Stack compact bar and text vertically.
//   peakCompactOrder   bar-first or text-first.
//   peakAlertEnabled   Warn before a pricing-period change.
//   peakAlertAhead     Warning lead time in minutes (1-30).
//   peakAlertTarget    both, peak, or offpeak.
//   peakAlertPosition  corner or center.
//   peakAlertWebNotify Also send a browser notification.
//   peakEffectiveAt    ISO timestamp for the pricing feature gate.
//
// Cloud sync settings:
//   cloudEnabled       Disabled by default; requires a valid cloudUrl.
//   cloudUrl           User-controlled HTTP/HTTPS sync endpoint.
//   cloudToken         Bootstrap/device token.
//   deviceName         Human-readable device label.
//   deviceId           Optional manual device identity override.
//   syncIntervalSec    Automatic sync interval (15..3600 seconds).
//   syncBatchSize      Records per sync batch (50..2000).
//   maskSessionId      Hash session identifiers before upload.
//   includePurpose     Upload project/purpose metadata only when opted in.
//   syncRollups        Upload historical daily rollups.
//   syncSinceDays      Historical backfill window; 0 means unlimited.
//   cloudView          local | local+cloud | cloud.
//   cloudPanelDevices  Optional device filter for cloud views.
// ============================================================

/** Default effective timestamp for peak/off-peak pricing. */
export const DEFAULT_PEAK_EFFECTIVE_AT = '2026-08-01T00:00:00Z'

/** Return the default peak-pricing configuration. */
export function defaultPeakConfig() {
  return {
    peakEnabled: true,
    peakNotice: true,
    peakStyle: 'compact',
    peakShowTickLabels: true,
    peakCompactStack: false,
    peakCompactOrder: 'bar-first',
    peakAlertEnabled: true,
    peakAlertAhead: 2,
    peakAlertTarget: 'both',
    peakAlertPosition: 'corner',
    peakAlertWebNotify: false,
    peakEffectiveAt: DEFAULT_PEAK_EFFECTIVE_AT,
  }
}

/**
 * Return privacy-first cloud defaults.
 *
 * Cloud transport remains disabled. If a user later enables it manually,
 * session ids are hashed by default and project/purpose metadata remains off
 * until explicitly opted in.
 */
export function defaultCloudConfig() {
  return {
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
    lastSyncAt: 0,
    lastSyncOk: false,
    lastSyncError: '',
  }
}

/** Supported dashboard data-source views. */
export const BOARD_VIEWS = ['local', 'local+cloud', 'cloud']

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function intIn(value, low, high, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high ? value : fallback
}

/**
 * Normalize peak-pricing input, keeping only known settings and safe values.
 *
 * @param {object} raw Arbitrary user input.
 * @returns {object} Normalized peak-pricing configuration.
 */
export function normalizePeakConfig(raw) {
  const defaults = defaultPeakConfig()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaults

  return {
    peakEnabled: bool(raw.peakEnabled, defaults.peakEnabled),
    peakNotice: bool(raw.peakNotice, defaults.peakNotice),
    peakStyle: raw.peakStyle === 'classic' ? 'classic' : 'compact',
    peakShowTickLabels: bool(raw.peakShowTickLabels, defaults.peakShowTickLabels),
    peakCompactStack: bool(raw.peakCompactStack, defaults.peakCompactStack),
    peakCompactOrder: raw.peakCompactOrder === 'text-first' ? 'text-first' : 'bar-first',
    peakAlertEnabled: bool(raw.peakAlertEnabled, defaults.peakAlertEnabled),
    peakAlertAhead: intIn(raw.peakAlertAhead, 1, 30, defaults.peakAlertAhead),
    peakAlertTarget: raw.peakAlertTarget === 'peak' || raw.peakAlertTarget === 'offpeak'
      ? raw.peakAlertTarget
      : defaults.peakAlertTarget,
    peakAlertPosition: raw.peakAlertPosition === 'center' ? 'center' : 'corner',
    peakAlertWebNotify: bool(raw.peakAlertWebNotify, defaults.peakAlertWebNotify),
    peakEffectiveAt: typeof raw.peakEffectiveAt === 'string' && raw.peakEffectiveAt.length > 0
      ? raw.peakEffectiveAt
      : defaults.peakEffectiveAt,
  }
}

/**
 * Normalize cloud sync configuration.
 *
 * Privacy defaults deliberately remain secure when a field is omitted:
 * - maskSessionId defaults to true.
 * - includePurpose defaults to false and requires explicit true.
 * Invalid non-boolean values are rejected rather than coerced.
 *
 * @param {object} raw Arbitrary user input.
 * @returns {object} Normalized cloud configuration.
 */
export function normalizeCloudConfig(raw) {
  const defaults = defaultCloudConfig()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaults

  const url = typeof raw.cloudUrl === 'string' ? raw.cloudUrl.trim().replace(/\/+$/, '') : ''
  const validUrl = /^https?:\/\/[^\s]+$/i.test(url) ? url.slice(0, 512) : ''

  return {
    cloudEnabled: raw.cloudEnabled === true && !!validUrl,
    cloudUrl: validUrl,
    cloudToken: typeof raw.cloudToken === 'string' ? raw.cloudToken.trim().slice(0, 512) : '',
    deviceName: typeof raw.deviceName === 'string' ? raw.deviceName.trim().slice(0, 64) : '',
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId.trim().slice(0, 128) : '',
    syncIntervalSec: intIn(raw.syncIntervalSec, 15, 3600, defaults.syncIntervalSec),
    syncBatchSize: intIn(raw.syncBatchSize, 50, 2000, defaults.syncBatchSize),
    maskSessionId: raw.maskSessionId === undefined ? defaults.maskSessionId : raw.maskSessionId === true,
    includePurpose: raw.includePurpose === true,
    syncRollups: raw.syncRollups !== false,
    syncSinceDays: intIn(raw.syncSinceDays, 0, 3650, defaults.syncSinceDays),
    cloudView: BOARD_VIEWS.includes(raw.cloudView) ? raw.cloudView : defaults.cloudView,
    cloudPanelDevices: Array.isArray(raw.cloudPanelDevices)
      ? raw.cloudPanelDevices.map((value) => String(value)).filter(Boolean).slice(0, 64)
      : [],
    lastSyncAt: Number.isFinite(raw.lastSyncAt) ? Number(raw.lastSyncAt) : 0,
    lastSyncOk: raw.lastSyncOk === true,
    lastSyncError: typeof raw.lastSyncError === 'string' ? raw.lastSyncError.slice(0, 300) : '',
  }
}

/** Normalize the combined plugin configuration file. */
export function normalizePluginConfig(raw) {
  return Object.assign(normalizePeakConfig(raw), normalizeCloudConfig(raw))
}

/**
 * Return true when peak pricing is enabled and its effective time has passed.
 *
 * @param {object} config Normalized configuration.
 * @param {number} now Epoch milliseconds.
 * @returns {boolean}
 */
export function peakEffective(config, now) {
  if (!config || config.peakEnabled !== true) return false
  const effectiveAt = Date.parse((config && config.peakEffectiveAt) || '')
  if (Number.isFinite(effectiveAt) && now < effectiveAt) return false
  return true
}
