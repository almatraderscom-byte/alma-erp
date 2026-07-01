/** Strip JSON Schema fields Gemini rejects. */
export function sanitizeSchemaForGemini(schema: object): object {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }

  const walk = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(walk)

    const obj = { ...(node as Record<string, unknown>) }
    delete obj.$schema
    delete obj.additionalProperties
    delete obj.$defs
    delete obj.definitions

    // Gemini's function-declaration validator only accepts STRING enums: an enum whose
    // members are numbers/booleans (e.g. `{ type: 'integer', enum: [2, 3] }`) is rejected
    // with "Invalid value ... (TYPE_STRING)" and the whole tool call 400s. Anthropic
    // tolerates typed enums, so this only bites on the Gemini head. Coerce every enum to
    // string members + string type so the tool is accepted; the arg still round-trips as
    // its string form, which the tool handlers parse.
    if (Array.isArray(obj.enum)) {
      obj.enum = (obj.enum as unknown[]).map((e) =>
        e === null || e === undefined ? e : String(e),
      )
      obj.type = 'string'
    }

    for (const [k, v] of Object.entries(obj)) {
      if (k === 'format' && typeof v === 'string' && !['enum', 'date-time'].includes(v)) {
        delete obj.format
        continue
      }
      if (k === 'enum') continue // already normalized above
      obj[k] = walk(v)
    }
    return obj
  }

  return walk(schema) as object
}
