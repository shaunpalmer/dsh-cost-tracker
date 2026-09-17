import { readFileSync } from 'node:fs'
import { defaultCloudConfig, normalizeCloudConfig } from '../config.js'
import { normalizeCloudConfig as normalizeSyncCloudConfig } from '../sync.js'

let failures = 0
let passes = 0

function check(condition, message) {
  if (condition) {
    passes += 1
    return
  }
  failures += 1
  console.error('FAIL: ' + message)
}

function read(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8')
}

const packageJson = JSON.parse(read('package.json'))
const client = read('client.js')
const view = read('view.js')
const wrapper = read('index.safe.js')
const store = read('store.js')
const sync = read('sync.js')
const cordis = read('cordis.patch.yml')

check(packageJson.name === '@shaunpalmer/dsh-cost-tracker', 'fork package id is Project Studios scoped')
check(packageJson.main === 'index.safe.js', 'hardened wrapper is the package entrypoint')
check(packageJson.exports['./client'] === './client.js', 'DSH client export resolves to the English client')
check(client.includes("id: '@shaunpalmer/dsh-cost-tracker'"), 'browser bundle id matches package id')
check(view.includes('id: "@shaunpalmer/dsh-cost-tracker/view"'), 'view bundle id matches fork package id')
check(cordis.includes('name: "@shaunpalmer/dsh-cost-tracker"'), 'Cordis patch points at the fork package')

check(client.includes("FX_ENDPOINT = 'https://api.frankfurter.dev/v2/rate/cny/nzd'"), 'NZD display uses the documented Frankfurter CNY to NZD reference endpoint')
check(client.includes("FX_CACHE_KEY = 'project-studios-cost-tracker:fx:cny-nzd:v1'"), 'FX rate has a namespaced browser cache')
check(client.includes('FX_CACHE_TTL_MS = 24 * 60 * 60 * 1000'), 'FX cache refreshes daily')
check(client.includes("return 'NZ$' + number.toLocaleString('en-NZ'"), 'NZD values use explicit New Zealand display formatting')
check(client.includes("return { primary: cnyLabel(cny), secondary: '' }"), 'CNY remains the safe display fallback when FX is unavailable')
check(client.includes('CNY remains canonical.'), 'UI states that CNY remains the canonical accounting currency')
check(client.includes('Display conversion must never make the tracker unusable.'), 'FX cache failures are isolated from the cost tracker')

const defaults = defaultCloudConfig()
check(defaults.cloudEnabled === false, 'cloud sync is disabled by default')
check(defaults.maskSessionId === true, 'session ids are masked by default')
check(defaults.includePurpose === false, 'purpose metadata is excluded by default')

const normalizedMissing = normalizeCloudConfig({ cloudUrl: 'https://example.invalid', cloudEnabled: true })
check(normalizedMissing.maskSessionId === true, 'missing maskSessionId remains privacy-safe')
check(normalizedMissing.includePurpose === false, 'missing includePurpose remains privacy-safe')

const normalizedOptIn = normalizeCloudConfig({
  cloudUrl: 'https://example.invalid',
  cloudEnabled: true,
  maskSessionId: false,
  includePurpose: true,
})
check(normalizedOptIn.maskSessionId === false, 'explicit session-id opt-out is preserved')
check(normalizedOptIn.includePurpose === true, 'explicit purpose opt-in is preserved')

const syncDefaults = normalizeSyncCloudConfig({})
check(syncDefaults.cloudEnabled === false, 'sync engine keeps cloud disabled by default')
check(syncDefaults.maskSessionId === true, 'sync engine masks session ids by default')
check(syncDefaults.includePurpose === false, 'sync engine excludes purpose metadata by default')
check(sync.includes('mode: 0o700'), 'sync directories are created owner-only')
check(sync.includes('mode: 0o600'), 'sync identity/state files are written owner-only')

check(wrapper.includes("SAFE_ENTRY_SENTINEL = '/nonexistent/project-studios/dsh-cost-tracker'"), 'wrapper blocks upstream DSH installation discovery')
check(wrapper.includes("BLOCKED_SETTINGS_SERVICE = 'settings'"), 'wrapper suppresses the upstream settings surface')
check(store.includes('mode: 0o700'), 'storage directory is created owner-only')
check(store.includes('mode: 0o600'), 'storage file is written owner-only')

const englishSurfaceFiles = [
  'client.js',
  'index.safe.js',
  'view.js',
  'config.js',
  'store.js',
  'sync.js',
  'schema.js',
  'README.md',
  'CHANGELOG.md',
  'HARDENING.md',
  'cordis.patch.yml',
]
const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

for (const path of englishSurfaceFiles) {
  check(!cjk.test(read(path)), path + ' contains no CJK characters')
}

console.log('\n' + passes + ' passed, ' + failures + ' failed')
process.exit(failures === 0 ? 0 : 1)