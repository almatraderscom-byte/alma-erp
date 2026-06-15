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

    for (const [k, v] of Object.entries(obj)) {
      if (k === 'format' && typeof v === 'string' && !['enum', 'date-time'].includes(v)) {
        delete obj.format
        continue
      }
      obj[k] = walk(v)
    }
    return obj
  }

  return walk(schema) as object
}
