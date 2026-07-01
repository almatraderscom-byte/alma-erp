/**
 * Reduce a JSON Schema to the strict subset Gemini's function-declaration
 * (proto-validated OpenAPI Schema) accepts.
 *
 * Gemini is far stricter than Anthropic: its validator only knows a small set of
 * keys, and it rejects the WHOLE tool call with a 400 ("Invalid value ...") when
 * it meets anything else. Two traps we hit in production:
 *   1. Numeric/boolean enums (`{ type:'integer', enum:[2,3] }`) — the proto `enum`
 *      field is `repeated string`, so a number 400s with "(TYPE_STRING), 2".
 *   2. `minItems` / `maxItems` (and other numeric constraints) — proto-typed int64,
 *      which ProtoJSON expects as a *string*; a raw number 400s the same way.
 *
 * Rather than play whack-a-mole per field, we WHITELIST the handful of keys Gemini
 * reliably supports and drop everything else. The dropped constraints (min/max
 * items, ranges, patterns, defaults, $schema/$defs/additionalProperties, etc.) are
 * advisory only — the tool handlers still validate their args via zod on our side —
 * so removing them changes nothing functionally while guaranteeing the tool is
 * accepted. Enums are additionally coerced to string members + `type:'string'` so
 * they round-trip as strings, which the handlers parse.
 */
const ALLOWED_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
])

export function sanitizeSchemaForGemini(schema: object): object {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }

  const walk = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(walk)

    const src = node as Record<string, unknown>
    const out: Record<string, unknown> = {}

    // Enum coercion first: Gemini only accepts STRING enum members, and a typed
    // enum (integer/number/boolean) must become a string enum + string type.
    if (Array.isArray(src.enum)) {
      out.enum = (src.enum as unknown[]).map((e) =>
        e === null || e === undefined ? e : String(e),
      )
      out.type = 'string'
    }

    for (const [k, v] of Object.entries(src)) {
      if (!ALLOWED_KEYS.has(k)) continue // drop anything Gemini can choke on
      if (k === 'enum') continue // already normalized above
      if (k === 'type' && Array.isArray(out.enum)) continue // enum forced type='string'

      if (k === 'format') {
        // Gemini only accepts a few string formats; strip the rest.
        if (typeof v === 'string' && ['enum', 'date-time'].includes(v)) out.format = v
        continue
      }

      if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
        // `properties` is a name→subschema MAP: keep every property name, walk values.
        const props: Record<string, unknown> = {}
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) props[pk] = walk(pv)
        out.properties = props
        continue
      }

      out[k] = walk(v)
    }

    return out
  }

  return walk(schema) as object
}
