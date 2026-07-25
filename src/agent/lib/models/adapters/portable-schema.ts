/**
 * Universal pipeline Phase 5 — portable JSON-Schema normalisation for the
 * OpenAI-compatible path (raw OpenAI, xAI-direct, OpenRouter → DeepSeek/Qwen/
 * Grok/Gemini-via-OR).
 *
 * Bug C: the Gemini adapter has always sanitised its function declarations
 * (gemini-schema.ts), but `toOpenAiTools` passed our schemas through RAW. The
 * registry's 327 schemas are hand-written Anthropic-shape objects and are not
 * uniform: some carry `$schema`/`$defs`/`$ref`, some vendor extensions, a few
 * omit `type`/`properties` entirely. Different providers behind the same
 * OpenAI-shaped API disagree about what they tolerate, so "the same tool" was
 * effectively a different tool per model — the exact model-dependence this
 * program exists to kill.
 *
 * This sanitiser is deliberately LIGHT (the opposite trade-off to Gemini's lossy
 * whitelist): it keeps every constraint a model can use to fill arguments
 * correctly (enum, min/max, pattern, items, nested objects, defaults,
 * additionalProperties) and only removes what no provider can act on:
 *   - `$schema`, `$id`, `$comment`, `definitions`/`$defs`, and any `$ref`
 *     (unresolvable once the definitions are gone — replaced by a permissive
 *     node so the argument still exists rather than the tool 400'ing);
 *   - vendor extensions (`x-*`) and our own annotation keys;
 *   - `required` entries that name no declared property (a real source of
 *     "model must send a field that isn't in the schema" confusion).
 * It also GUARANTEES the top level is a usable object schema
 * (`type: 'object'` + `properties`) and emits keys in a deterministic order, so
 * the serialized tool block is byte-stable turn to turn — a prefix-cache
 * requirement.
 *
 * Handler-side zod validation is unchanged; this only shapes what the model sees.
 */

/** Dropped everywhere — structural/vendor keys no provider evaluates for us. */
const DROP_KEYS = new Set([
  '$schema',
  '$id',
  '$comment',
  '$defs',
  'definitions',
  'deprecated',
  'readOnly',
  'writeOnly',
  'examples',
])

/** Deterministic emission order; anything unlisted follows, alphabetically. */
const KEY_ORDER = [
  'type',
  'description',
  'enum',
  'const',
  'default',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
  'properties',
  'required',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
  'nullable',
]

function orderKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of KEY_ORDER) {
    if (k in obj) out[k] = obj[k]
  }
  for (const k of Object.keys(obj).sort()) {
    if (!(k in out)) out[k] = obj[k]
  }
  return out
}

function walk(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(walk)

  const src = node as Record<string, unknown>

  // A `$ref` cannot be followed once `$defs`/`definitions` are dropped. Rather
  // than ship a dangling pointer (some providers 400, others silently ignore the
  // whole property), degrade to a permissive node so the argument still exists.
  if (typeof src.$ref === 'string') {
    const desc = typeof src.description === 'string' ? src.description : undefined
    return desc ? { description: desc } : {}
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (DROP_KEYS.has(k)) continue
    if (k.startsWith('x-')) continue // vendor extensions

    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      // name→subschema MAP: property names are DATA, never schema keywords.
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = walk(pv)
      out.properties = props
      continue
    }
    out[k] = walk(v)
  }

  // `required` must only name declared properties.
  if (Array.isArray(out.required)) {
    const declared = new Set(Object.keys((out.properties ?? {}) as Record<string, unknown>))
    const kept = (out.required as unknown[])
      .filter((r): r is string => typeof r === 'string')
      .filter((r) => declared.size === 0 || declared.has(r))
    if (kept.length > 0) out.required = kept
    else delete out.required
  }

  // An object node that declares properties must say so — a missing `type` makes
  // several providers treat the argument block as a free-form string.
  if (out.properties && !out.type) out.type = 'object'

  return orderKeys(out)
}

/**
 * Normalise one tool input schema for the OpenAI-compatible wire format.
 * Always returns a usable object schema, even for junk input.
 */
export function sanitizeSchemaPortable(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} }
  }
  const walked = walk(schema) as Record<string, unknown>
  if (walked.type !== 'object') walked.type = 'object'
  if (!walked.properties || typeof walked.properties !== 'object') walked.properties = {}
  return orderKeys(walked)
}
