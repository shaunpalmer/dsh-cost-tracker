// Project Studios hardened host wrapper for dsh-cost-tracker.
//
// Architecture:
// - Keep the upstream accounting engine intact in index.js.
// - Block the upstream startup routine from patching DSH's installed UI files.
// - Suppress the upstream settings-schema registration because its current
//   descriptions are Chinese and the hardened client intentionally exposes a
//   smaller local-first surface.
// - Preserve tools, routes, accounting hooks, storage, pricing and sync logic.
//
// This is composition rather than a fork-wide rewrite: the risky integration
// edges are isolated here while the tested accounting core remains unchanged.

import upstreamPlugin from './index.js'

const BLOCKED_SETTINGS_SERVICE = 'settings'
const SAFE_ENTRY_SENTINEL = '/nonexistent/project-studios/dsh-cost-tracker'

/**
 * Build a Context proxy that preserves normal DSH services while hiding the
 * optional settings service from the upstream plugin. This prevents the old
 * Chinese settings schema from becoming a second configuration surface.
 *
 * @param {object} ctx DSH plugin context.
 * @returns {object} Proxied context.
 */
function createHardenedContext(ctx) {
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'get' && typeof target.get === 'function') {
        return function getService(name, ...args) {
          if (name === BLOCKED_SETTINGS_SERVICE) return undefined
          return target.get.call(target, name, ...args)
        }
      }

      if (prop === 'inject' && typeof target.inject === 'function') {
        return function injectServices(dependencies, callback, ...args) {
          if (Array.isArray(dependencies) && dependencies.includes(BLOCKED_SETTINGS_SERVICE)) {
            return undefined
          }
          return target.inject.call(target, dependencies, callback, ...args)
        }
      }

      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Run the upstream host plugin without allowing its nav-icon self-patcher to
 * discover DSH's installation tree. The original argv value is restored even
 * if startup throws.
 *
 * @param {object} ctx DSH plugin context.
 * @returns {*} Whatever the upstream apply hook returns.
 */
function apply(ctx) {
  const originalEntry = process.argv[1]
  process.argv[1] = SAFE_ENTRY_SENTINEL

  try {
    return upstreamPlugin.apply(createHardenedContext(ctx))
  } finally {
    process.argv[1] = originalEntry
  }
}

export default {
  ...upstreamPlugin,
  name: 'cost-tracker',
  apply,
}
