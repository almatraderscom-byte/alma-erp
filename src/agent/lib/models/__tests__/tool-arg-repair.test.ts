import { describe, it, expect } from 'vitest'
import { repairToolArgs } from '../tool-arg-repair'

describe('repairToolArgs (P8 — tool-call integrity)', () => {
  it('passes valid JSON through unchanged (no repair)', () => {
    expect(repairToolArgs('{"a":1,"b":"x"}')).toEqual({ ok: true, value: { a: 1, b: 'x' }, repaired: false })
  })

  it('treats empty / whitespace / null as {} (matches old `|| "{}"`)', () => {
    expect(repairToolArgs('')).toEqual({ ok: true, value: {}, repaired: false })
    expect(repairToolArgs('   ')).toEqual({ ok: true, value: {}, repaired: false })
    expect(repairToolArgs(null)).toEqual({ ok: true, value: {}, repaired: false })
    expect(repairToolArgs(undefined)).toEqual({ ok: true, value: {}, repaired: false })
  })

  it('strips markdown code fences', () => {
    const r = repairToolArgs('```json\n{"a":1}\n```')
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.value).toEqual({ a: 1 }); expect(r.repaired).toBe(true) }
  })

  it('removes trailing commas', () => {
    const r = repairToolArgs('{"a":1,"b":2,}')
    expect(r.ok && r.value).toEqual({ a: 1, b: 2 })
  })

  it('balances a truncated object (missing closing brace)', () => {
    const r = repairToolArgs('{"a":1,"b":{"c":2}')
    expect(r.ok && r.value).toEqual({ a: 1, b: { c: 2 } })
  })

  it('extracts the object out of surrounding prose', () => {
    const r = repairToolArgs('Sure! {"a":1} hope that helps')
    expect(r.ok && r.value).toEqual({ a: 1 })
  })

  it('converts single quotes when that yields valid JSON', () => {
    const r = repairToolArgs("{'a':'b'}")
    expect(r.ok && r.value).toEqual({ a: 'b' })
  })

  it('reports failure (never {_raw} passthrough) for hopeless input', () => {
    const r = repairToolArgs('not json at all <<<')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.raw).toBe('not json at all <<<')
  })
})
