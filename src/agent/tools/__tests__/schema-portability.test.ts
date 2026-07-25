/**
 * Universal pipeline Phase 0/5 — every tool schema must survive every provider.
 *
 * Bug C: the Gemini adapter sanitised its function declarations, the
 * OpenAI/xAI/OpenRouter adapter passed ours through RAW. "The same tool" was
 * therefore a slightly different tool per model — precisely the model-dependence
 * this program removes. These are ratchets: the allowlists may only shrink.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_GROUPS, TOOL_GROUP_NAMES } from '../tool-groups'
import type { AgentTool } from '../registry'
import { sanitizeSchemaPortable } from '@/agent/lib/models/adapters/portable-schema'
import { sanitizeSchemaForGemini } from '@/agent/lib/models/adapters/gemini-schema'

const ALL_TOOLS: AgentTool[] = (() => {
  const seen = new Map<string, AgentTool>()
  for (const g of TOOL_GROUP_NAMES) {
    for (const t of TOOL_GROUPS[g] ?? []) if (!seen.has(t.name)) seen.set(t.name, t)
  }
  return [...seen.values()]
})()

/**
 * RATCHET — tools still missing a strict shape. This list may only get SHORTER.
 * Adding a name here is a regression; fix the schema instead.
 */
const MISSING_REQUIRED_ALLOWLIST: string[] = []

describe('registry schema strictness (ratchet)', () => {
  it('has a non-trivial number of tools (guards against an empty-import false pass)', () => {
    expect(ALL_TOOLS.length).toBeGreaterThan(250)
  })

  it("every schema is an object schema with `properties`", () => {
    const bad = ALL_TOOLS.filter((t) => {
      const s = t.input_schema as Record<string, unknown> | undefined
      return !s || s.type !== 'object' || typeof s.properties !== 'object'
    }).map((t) => t.name)
    expect(bad).toEqual([])
  })

  it('declares `required` (ratchet list may only shrink)', () => {
    const missing = ALL_TOOLS.filter((t) => {
      const s = t.input_schema as Record<string, unknown>
      return !Array.isArray(s.required)
    }).map((t) => t.name)
    const unexpected = missing.filter((n) => !MISSING_REQUIRED_ALLOWLIST.includes(n))
    expect(unexpected).toEqual([])
    // ratchet: an allowlist entry that no longer fails must be deleted
    expect(MISSING_REQUIRED_ALLOWLIST.filter((n) => !missing.includes(n))).toEqual([])
  })

  it('every `required` entry names a declared property', () => {
    const bad: string[] = []
    for (const t of ALL_TOOLS) {
      const s = t.input_schema as Record<string, unknown>
      const props = new Set(Object.keys((s.properties ?? {}) as Record<string, unknown>))
      for (const r of (Array.isArray(s.required) ? s.required : []) as string[]) {
        if (!props.has(r)) bad.push(`${t.name}.${r}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('carries no unresolvable $ref (definitions are not shipped to providers)', () => {
    const bad = ALL_TOOLS.filter((t) => JSON.stringify(t.input_schema).includes('"$ref"')).map((t) => t.name)
    expect(bad).toEqual([])
  })
})

describe('portable sanitiser (Phase 5)', () => {
  it('is a no-op on the shape our registry already uses (no silent arg changes)', () => {
    const changed: string[] = []
    for (const t of ALL_TOOLS) {
      const before = t.input_schema as Record<string, unknown>
      const after = sanitizeSchemaPortable(before)
      // Same property names, same required set, same enums — only key ORDER may differ.
      const beforeProps = Object.keys((before.properties ?? {}) as object).sort()
      const afterProps = Object.keys((after.properties ?? {}) as object).sort()
      const beforeReq = [...((before.required as string[]) ?? [])].sort()
      const afterReq = [...((after.required as string[]) ?? [])].sort()
      if (
        JSON.stringify(beforeProps) !== JSON.stringify(afterProps)
        || JSON.stringify(beforeReq) !== JSON.stringify(afterReq)
      ) changed.push(t.name)
    }
    expect(changed).toEqual([])
  })

  it('is idempotent and byte-stable (prefix-cache requirement)', () => {
    for (const t of ALL_TOOLS) {
      const once = JSON.stringify(sanitizeSchemaPortable(t.input_schema))
      const twice = JSON.stringify(sanitizeSchemaPortable(sanitizeSchemaPortable(t.input_schema)))
      expect(twice).toBe(once)
    }
  })

  it('emits keys in a deterministic order regardless of input key order', () => {
    const a = { properties: { b: { type: 'string' } }, type: 'object', required: ['b'], description: 'x' }
    const b = { description: 'x', required: ['b'], type: 'object', properties: { b: { type: 'string' } } }
    expect(JSON.stringify(sanitizeSchemaPortable(a))).toBe(JSON.stringify(sanitizeSchemaPortable(b)))
  })

  it('keeps constraints Gemini drops — it is normalising, not lossy', () => {
    const schema = {
      type: 'object',
      properties: {
        n: { type: 'integer', minimum: 1, maximum: 10 },
        s: { type: 'string', pattern: '^a', minLength: 2 },
        list: { type: 'array', items: { type: 'string' }, minItems: 1 },
        mode: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['n'],
    }
    const portable = sanitizeSchemaPortable(schema) as Record<string, unknown>
    const props = portable.properties as Record<string, Record<string, unknown>>
    expect(props.n.minimum).toBe(1)
    expect(props.s.pattern).toBe('^a')
    expect(props.list.minItems).toBe(1)
    expect(props.mode.enum).toEqual(['a', 'b'])
    expect(portable.required).toEqual(['n'])
    // Gemini's whitelist legitimately drops these; portable does not.
    const gem = sanitizeSchemaForGemini(schema) as Record<string, unknown>
    const gemProps = gem.properties as Record<string, Record<string, unknown>>
    expect(gemProps.n.minimum).toBeUndefined()
  })

  it('drops structural/vendor keys and degrades a dangling $ref instead of shipping it', () => {
    const out = sanitizeSchemaPortable({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { X: { type: 'string' } },
      'x-internal': true,
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/X', description: 'keep me' },
        b: { type: 'string' },
      },
      required: ['b', 'ghost'],
    }) as Record<string, unknown>
    expect(out.$schema).toBeUndefined()
    expect(out.$defs).toBeUndefined()
    expect(out['x-internal']).toBeUndefined()
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(props.a.$ref).toBeUndefined()
    expect(props.a.description).toBe('keep me')
    // `ghost` is not a declared property — a model told to send it can only fail.
    expect(out.required).toEqual(['b'])
  })

  it('never returns junk for junk input', () => {
    for (const junk of [null, undefined, 42, 'nope', []]) {
      const out = sanitizeSchemaPortable(junk)
      expect(out.type).toBe('object')
      expect(out.properties).toEqual({})
    }
  })
})
