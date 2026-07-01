import { describe, it, expect } from 'vitest'
import { sanitizeSchemaForGemini } from '@/agent/lib/models/adapters/gemini-schema'

describe('sanitizeSchemaForGemini', () => {
  it('coerces a numeric enum to string members + string type (Gemini rejects numeric enums)', () => {
    // This is the exact shape that 400'd the Gemini head:
    //   Invalid value at '...enum[0]' (TYPE_STRING), 2
    const out = sanitizeSchemaForGemini({
      type: 'object',
      properties: {
        level: { type: 'integer', enum: [2, 3] },
      },
    }) as any
    expect(out.properties.level.type).toBe('string')
    expect(out.properties.level.enum).toEqual(['2', '3'])
  })

  it('normalizes a nested numeric enum inside array items', () => {
    const out = sanitizeSchemaForGemini({
      type: 'object',
      properties: {
        codes: { type: 'array', items: { type: 'number', enum: [1, 2, 3] } },
      },
    }) as any
    expect(out.properties.codes.items.type).toBe('string')
    expect(out.properties.codes.items.enum).toEqual(['1', '2', '3'])
  })

  it('leaves a string enum untouched', () => {
    const out = sanitizeSchemaForGemini({
      type: 'object',
      properties: { role: { type: 'string', enum: ['ops', 'cs'] } },
    }) as any
    expect(out.properties.role.type).toBe('string')
    expect(out.properties.role.enum).toEqual(['ops', 'cs'])
  })

  it('still strips Gemini-unsupported fields ($schema, additionalProperties, $defs)', () => {
    const out = sanitizeSchemaForGemini({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      $defs: { X: { type: 'string' } },
      properties: { a: { type: 'string' } },
    }) as any
    expect(out.$schema).toBeUndefined()
    expect(out.additionalProperties).toBeUndefined()
    expect(out.$defs).toBeUndefined()
    expect(out.properties.a.type).toBe('string')
  })
})
