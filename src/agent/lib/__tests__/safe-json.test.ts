/** safe-json — the one guarded door for model-produced JSON (2026-07-16). */
import { describe, it, expect } from 'vitest'
import { parseModelJson, isObjectWith, isArrayOf } from '../safe-json'

describe('parseModelJson', () => {
  it('parses clean JSON', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })
  it('parses fenced ```json blocks with surrounding prose', () => {
    const raw = 'ঠিক আছে বস, ফল:\n```json\n{"done": true, "reason": "সব শেষ"}\n```\nআর কিছু?'
    const r = parseModelJson(raw, isObjectWith('done'))
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as { done: boolean }).done).toBe(true)
  })
  it('extracts a balanced object buried in prose (braces inside strings survive)', () => {
    const raw = 'verdict: {"reason": "brace } inside", "done": false} — done'
    const r = parseModelJson(raw, isObjectWith('done'))
    expect(r.ok).toBe(true)
  })
  it('repairs trailing commas and smart quotes', () => {
    const r = parseModelJson('{“items”: [1, 2, 3,], }')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ items: [1, 2, 3] })
  })
  it('shape guard rejects wrong shapes instead of half-accepting', () => {
    const r = parseModelJson('{"other": 1}', isObjectWith('done'))
    expect(r).toEqual({ ok: false, error: 'shape_rejected' })
  })
  it('never throws on garbage / empty', () => {
    expect(parseModelJson('no json here').ok).toBe(false)
    expect(parseModelJson('').ok).toBe(false)
    expect(parseModelJson(undefined).ok).toBe(false)
    expect(parseModelJson('{broken').ok).toBe(false)
  })
  it('isArrayOf guards element shapes', () => {
    const guard = isArrayOf(isObjectWith('id'))
    expect(parseModelJson('[{"id":1},{"id":2}]', guard).ok).toBe(true)
    expect(parseModelJson('[{"id":1},{"x":2}]', guard).ok).toBe(false)
  })
})
