// ============================================================
// DSH Cost Tracker - minimal zero-dependency settings schema.
//
// Registering a ctx.settings namespace requires a schemastery-shaped object,
// but this plugin intentionally has no required npm runtime dependencies. The
// DSH host's own schemastery package is not guaranteed to resolve from this
// package, so we implement only the three behaviours the host consumes:
//
// 1. A callable schema: schema(rawValue) -> normalized value.
// 2. A .meta object on every node so secret fields can be redacted.
// 3. A .toJSON() method so the settings description can be sent to the client.
//
// Fields use .default(undefined) so only values explicitly saved by the user
// enter the user settings layer; existing values in the plugin config file are
// not silently overwritten.
// ============================================================

const TYPES = {}

/**
 * Create an unconstrained node that returns any JSON value unchanged.
 *
 * @param {object} meta Node metadata.
 * @returns {Function} Schema node.
 */
function anyNode(meta) {
  const node = (value) => value
  node.meta = meta || {}
  node.toJSON = () => ({ type: undefined, meta: node.meta })
  return node
}

/** Keep only keys declared by an object schema node. */
function pick(node, raw) {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const output = {}

  for (const [key, child] of Object.entries(node.dict)) {
    if (!(key in raw)) continue
    const value = child(raw[key])
    if (value !== undefined) output[key] = value
  }

  return output
}

function makeNode(type, meta, extra) {
  const node = (value) => {
    if (type === 'object') return pick(node, value)
    if (value === undefined) return undefined

    if (type === 'number') {
      const number = Number(value)
      return Number.isFinite(number) ? number : undefined
    }

    if (type === 'boolean') return typeof value === 'boolean' ? value : undefined
    if (type === 'string') return typeof value === 'string' ? value : undefined
    return value
  }

  node.meta = meta || {}
  Object.assign(node, extra || {})
  node.toJSON = () => {
    const output = { type, meta: node.meta }
    if (node.dict) {
      output.dict = {}
      for (const [key, child] of Object.entries(node.dict)) output.dict[key] = child.toJSON()
    }
    return output
  }

  return node
}

/**
 * Build the small schema API used by this plugin.
 *
 * The fluent methods intentionally mirror the subset of schemastery that DSH
 * expects: object, string, number, natural, boolean, role, default, and
 * description.
 */
export function defineSchema() {
  return {
    /** Object container that returns only declared keys. */
    object(dict) {
      const node = makeNode('object', { default: {} })
      node.dict = dict || {}
      return node
    },

    string() {
      const node = makeNode('string', {})
      node.role = (role) => { node.meta.role = role; return node }
      node.default = (value) => { node.meta.default = value; return node }
      node.description = (description) => { node.meta.description = description; return node }
      return node
    },

    number() {
      const node = makeNode('number', {})
      node.role = (role) => { node.meta.role = role; return node }
      node.default = (value) => { node.meta.default = value; return node }
      node.description = (description) => { node.meta.description = description; return node }
      return node
    },

    /** Non-negative integer with a step of one. */
    natural() {
      const node = makeNode('number', { step: 1, min: 0 })
      node.default = (value) => { node.meta.default = value; return node }
      node.description = (description) => { node.meta.description = description; return node }
      return node
    },

    boolean() {
      const node = makeNode('boolean', {})
      node.default = (value) => { node.meta.default = value; return node }
      node.description = (description) => { node.meta.description = description; return node }
      return node
    },

    any() {
      return anyNode({})
    },
  }
}

export const Schema = defineSchema()

/** Return the schema characteristics asserted by tests. */
export function schemaShape(schema) {
  return {
    callable: typeof schema === 'function',
    hasToJSON: typeof schema.toJSON === 'function',
    json: schema.toJSON(),
  }
}

export { TYPES }
