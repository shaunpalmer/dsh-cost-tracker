// ============================================================
// DSH Cost Tracker - persistent storage layer (pure Node.js)
//
// Retention model:
// - Detailed records are retained for DETAIL_DAYS.
// - Older records are compacted into permanent day + model rollups.
// - All-time totals remain detail + rollup, while memory and disk usage stay
//   bounded.
//
// Cloud sync support:
// - Every detail record has a monotonically increasing seq value.
// - resetEpoch increments after clear() so re-imported data is not mistaken for
//   an already-synced record.
// - Old files without seq/resetEpoch are upgraded during load.
//
// File format:
//   v2: { v: 2, seq, resetEpoch, details: [...], rollups: {...} }
//   v1: legacy bare array, migrated automatically.
// Corrupt files are renamed with a .corrupt-<timestamp> suffix and startup
// continues with an empty store.
// ============================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

/** Number of days retained as individual detail records. */
export const DETAIL_DAYS = 180
/** Maximum dashboard day-axis range. */
export const MAX_AXIS_DAYS = 730
/** Absolute detail-record safety cap. */
export const MAX_DETAILS = 200000
const DAY_MS = 86400000

function pad2(n) { return n < 10 ? '0' + n : '' + n }

/** Return a YYYY-MM-DD day key using Beijing time (UTC+8). */
export function dayKey(ts) {
  const d = new Date(ts + 28800000)
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
}

export function modelKeyOf(record) {
  return record.provider + '/' + record.model
}

export function emptyEntry(provider, model, subscription, estimated) {
  return {
    provider, model,
    subscription: !!subscription,
    estimated: !!estimated,
    calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    cost: 0, peak: 0, off: 0, flat: 0,
  }
}

/** Maximum absorbed detail hashes retained by one rollup entry. */
export const MAX_ABSORBED_KEYS = 5000

/**
 * Compute the canonical content hash used by cloud deduplication.
 *
 * @param {object} record Detail record.
 * @param {number} resetEpoch Current reset epoch.
 * @returns {string} SHA-256 hex digest.
 */
export function recordHashKey(record, resetEpoch) {
  const UNIT_SEPARATOR = '\u001f'
  const stringValue = (value) => (value === undefined || value === null ? '' : String(value).trim())
  const integerValue = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.trunc(n) : 0
  }
  const costValue = (value) => {
    const n = Number(value)
    return !Number.isFinite(n) || n === 0 ? '0' : String(Math.round(n * 1e6) / 1e6)
  }
  const tokens = (record && record.tokens) || {}
  const canonical = [
    'detail', integerValue(resetEpoch), integerValue(record && record.ts),
    stringValue(record && record.provider).toLowerCase(), stringValue(record && record.model).toLowerCase(),
    stringValue(record && record.sessionId), stringValue(record && record.purpose),
    integerValue(tokens.input), integerValue(tokens.output), integerValue(tokens.cacheRead), integerValue(tokens.cacheWrite), integerValue(tokens.reasoning),
    costValue(record && record.cost),
  ].join(UNIT_SEPARATOR)

  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function mergeIntoEntry(entry, record) {
  entry.calls += 1
  entry.input += record.tokens.input
  entry.output += record.tokens.output
  entry.cacheRead += record.tokens.cacheRead
  entry.cacheWrite += record.tokens.cacheWrite
  entry.cost += record.cost
  if (record.period === 'peak') entry.peak += record.cost
  else if (record.period === 'off-peak') entry.off += record.cost
  else entry.flat += record.cost
  return entry
}

/**
 * Fold one detail record into day + model rollups.
 *
 * The absorbed detail hash is retained so cloud aggregation can exclude an
 * original detail record after its local copy has been compacted.
 *
 * @param {object} rollups Rollup container.
 * @param {object} record Detail record.
 * @param {number} [resetEpoch] Current reset epoch.
 * @returns {object} Updated rollup entry.
 */
export function rollupRecord(rollups, record, resetEpoch) {
  const dayKeyValue = dayKey(record.ts)
  const modelKey = modelKeyOf(record)
  const day = rollups[dayKeyValue] || (rollups[dayKeyValue] = {})
  const entry = day[modelKey] || (day[modelKey] = emptyEntry(record.provider, record.model, record.subscription, record.estimated))

  mergeIntoEntry(entry, record)
  if (!Array.isArray(entry.absorbed)) entry.absorbed = []
  if (entry.absorbed.length < MAX_ABSORBED_KEYS) entry.absorbed.push(recordHashKey(record, resetEpoch || 0))
  if (entry.absorbed.length === MAX_ABSORBED_KEYS) entry.absorbedTruncated = true
  return entry
}

/**
 * Compact details older than the retention window.
 *
 * @returns {number} Number of compacted detail records.
 */
export function applyRetention(details, rollups, now, detailDays = DETAIL_DAYS, resetEpoch = 0) {
  const cutoff = now - detailDays * DAY_MS
  let index = 0

  while (index < details.length && details[index].ts < cutoff) {
    rollupRecord(rollups, details[index], resetEpoch)
    index++
  }

  if (index > 0) details.splice(0, index)
  return index
}

/** Collect all-time totals across details and rollups. */
export function collectTotals(details, rollups) {
  const totals = {
    realCost: 0,
    realCalls: 0,
    realTokens: 0,
    subEquivalent: 0,
    subCalls: 0,
    subTokens: 0,
    byModel: new Map(),
  }

  const add = (provider, model, subscription, estimated, calls, tokens, cost) => {
    const key = modelKeyOf({ provider, model })
    let item = totals.byModel.get(key)
    if (!item) {
      item = { model: key, subscription: !!subscription, estimated: !!estimated, calls: 0, tokens: 0, cost: 0 }
      totals.byModel.set(key, item)
    }

    item.calls += calls
    item.tokens += tokens
    item.cost += cost

    if (subscription) {
      totals.subCalls += calls
      totals.subEquivalent += cost
      totals.subTokens += tokens
    } else {
      totals.realCalls += calls
      totals.realCost += cost
      totals.realTokens += tokens
    }
  }

  for (const record of details) {
    add(
      record.provider,
      record.model,
      record.subscription,
      record.estimated,
      1,
      record.tokens.input + record.tokens.output + record.tokens.cacheRead + record.tokens.cacheWrite,
      record.cost,
    )
  }

  for (const dayKeyValue of Object.keys(rollups)) {
    const day = rollups[dayKeyValue]
    for (const modelKey of Object.keys(day)) {
      const entry = day[modelKey]
      add(
        entry.provider,
        entry.model,
        entry.subscription,
        entry.estimated,
        entry.calls,
        entry.input + entry.output + entry.cacheRead + entry.cacheWrite,
        entry.cost,
      )
    }
  }

  return totals
}

/** Collect day-level totals across details and rollups. */
export function collectByDay(details, rollups) {
  const days = new Map()

  const ensure = (dayKeyValue) => {
    let day = days.get(dayKeyValue)
    if (!day) {
      day = { peak: 0, off: 0, flat: 0, cost: 0, calls: 0, tokens: 0, subCost: 0, subCalls: 0 }
      days.set(dayKeyValue, day)
    }
    return day
  }

  for (const record of details) {
    const day = ensure(dayKey(record.ts))
    const tokenTotal = record.tokens.input + record.tokens.output + record.tokens.cacheRead + record.tokens.cacheWrite
    day.tokens += tokenTotal

    if (record.subscription) {
      day.subCost += record.cost
      day.subCalls += 1
    } else {
      day.calls += 1
      day.cost += record.cost
      if (record.period === 'peak') day.peak += record.cost
      else if (record.period === 'off-peak') day.off += record.cost
      else day.flat += record.cost
    }
  }

  for (const dayKeyValue of Object.keys(rollups)) {
    const day = ensure(dayKeyValue)
    for (const modelKey of Object.keys(rollups[dayKeyValue])) {
      const entry = rollups[dayKeyValue][modelKey]
      const tokenTotal = entry.input + entry.output + entry.cacheRead + entry.cacheWrite
      day.tokens += tokenTotal

      if (entry.subscription) {
        day.subCost += entry.cost
        day.subCalls += entry.calls
      } else {
        day.calls += entry.calls
        day.cost += entry.cost
        day.peak += entry.peak
        day.off += entry.off
        day.flat += entry.flat
      }
    }
  }

  return days
}

/**
 * Create a persistent cost store. details and rollups are mutable references.
 *
 * @param {string} filePath Data file path.
 * @param {{detailDays?:number, maxDetails?:number}} [options] Test overrides.
 * @returns {object} Store API.
 */
export function createStore(filePath, options) {
  const detailDays = (options && options.detailDays) || DETAIL_DAYS
  const maxDetails = (options && options.maxDetails) || MAX_DETAILS
  const details = []
  const rollups = {}
  let seq = 0
  let resetEpoch = 0
  let needsNumbering = false

  /** Assign seq values to legacy records in chronological order. */
  function assignSeq() {
    const sorted = details.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))
    let nextSeq = seq
    for (const record of sorted) nextSeq += 1

    let value = nextSeq - details.length + 1
    for (const record of sorted) {
      record.seq = value
      value += 1
    }

    sorted.sort((a, b) => (a.seq || 0) - (b.seq || 0))
    details.length = 0
    for (const record of sorted) details.push(record)
    seq = nextSeq
  }

  function load() {
    try {
      if (!existsSync(filePath)) return
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))

      if (Array.isArray(parsed)) {
        for (const record of parsed) if (isRecord(record)) details.push(record)
      } else if (parsed && typeof parsed === 'object') {
        if (Number.isFinite(parsed.seq)) seq = Math.max(0, Math.floor(parsed.seq))
        if (Number.isFinite(parsed.resetEpoch)) resetEpoch = Math.max(0, Math.floor(parsed.resetEpoch))

        if (Array.isArray(parsed.details)) {
          for (const record of parsed.details) {
            if (!isRecord(record)) continue
            if (!Number.isFinite(record.seq)) needsNumbering = true
            details.push(record)
          }
        }

        if (parsed.rollups && typeof parsed.rollups === 'object') {
          for (const dayKeyValue of Object.keys(parsed.rollups)) {
            const day = parsed.rollups[dayKeyValue]
            if (!day || typeof day !== 'object') continue

            for (const modelKey of Object.keys(day)) {
              const entry = day[modelKey]
              if (!entry || typeof entry !== 'object' || typeof entry.calls !== 'number') continue
              rollups[dayKeyValue] = rollups[dayKeyValue] || {}
              rollups[dayKeyValue][modelKey] = entry
            }
          }
        }
      }

      applyRetention(details, rollups, Date.now(), detailDays, resetEpoch)
      trimDetails()
      if (needsNumbering) assignSeq()

      let maxSeen = 0
      for (const record of details) {
        if (Number.isFinite(record.seq) && record.seq > maxSeen) maxSeen = record.seq
      }
      if (maxSeen > seq) seq = maxSeen
      return details.length
    } catch (error) {
      try { renameSync(filePath, filePath + '.corrupt-' + Date.now()) } catch (_) {}
      console.error('cost tracker load failed, starting empty', error)
      return 0
    }
  }

  function isRecord(record) {
    return !!record
      && typeof record === 'object'
      && typeof record.ts === 'number'
      && record.tokens
      && typeof record.tokens.input === 'number'
  }

  function trimDetails() {
    if (details.length > maxDetails) details.splice(0, details.length - maxDetails)
  }

  function add(record) {
    seq += 1
    record.seq = seq
    details.push(record)
    applyRetention(details, rollups, Date.now(), detailDays)
    trimDetails()
    return record
  }

  function persist() {
    try {
      // The store can contain session identifiers and purpose metadata. Keep
      // both the directory and atomic replacement file owner-only.
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
      const tempPath = filePath + '.tmp'
      writeFileSync(
        tempPath,
        JSON.stringify({ v: 2, seq, resetEpoch, details, rollups }),
        { encoding: 'utf8', mode: 0o600 },
      )
      renameSync(tempPath, filePath)
      return true
    } catch (error) {
      console.error('cost tracker persist failed', error)
      return false
    }
  }

  function clear() {
    details.length = 0
    for (const dayKeyValue of Object.keys(rollups)) delete rollups[dayKeyValue]
    resetEpoch += 1
    seq = 0
  }

  function counts() {
    let calls = details.length
    for (const dayKeyValue of Object.keys(rollups)) {
      for (const modelKey of Object.keys(rollups[dayKeyValue])) calls += rollups[dayKeyValue][modelKey].calls
    }
    return { details: details.length, calls, maxSeq: seq, resetEpoch }
  }

  return {
    details,
    rollups,
    load,
    add,
    persist,
    clear,
    counts,
    maxSeq: () => seq,
    epoch: () => resetEpoch,
    wasRenumbered: () => needsNumbering,
  }
}
