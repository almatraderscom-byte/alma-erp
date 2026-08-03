import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_MAX_ITEMS,
  MEMORY_MAX_ITEM_CHARS,
  MEMORY_MAX_TOTAL_CHARS,
  applyMemoryBudget,
  withMemoryTimeout,
} from '@/agent/lib/memory-budget'

const item = (content: string) => ({ id: content.slice(0, 6), content })

describe('applyMemoryBudget', () => {
  it('passes a small list through untouched', () => {
    const items = [item('ছোট তথ্য এক'), item('ছোট তথ্য দুই')]
    const result = applyMemoryBudget(items)
    expect(result.kept).toEqual(items)
    expect(result.dropped).toBe(0)
    expect(result.truncated).toBe(0)
  })

  it('enforces the item-count ceiling', () => {
    const items = Array.from({ length: 20 }, (_, i) => item(`fact ${i}`))
    const result = applyMemoryBudget(items)
    expect(result.kept).toHaveLength(MEMORY_MAX_ITEMS)
    expect(result.dropped).toBe(20 - MEMORY_MAX_ITEMS)
  })

  it('cuts an over-long item instead of dropping it', () => {
    const long = 'ক'.repeat(MEMORY_MAX_ITEM_CHARS + 500)
    const result = applyMemoryBudget([item(long)])
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0].content.length).toBe(MEMORY_MAX_ITEM_CHARS)
    expect(result.kept[0].content.endsWith('…')).toBe(true)
    expect(result.truncated).toBe(1)
  })

  it('never mutates the caller’s objects', () => {
    const original = item('ক'.repeat(MEMORY_MAX_ITEM_CHARS + 10))
    const before = original.content
    applyMemoryBudget([original])
    expect(original.content).toBe(before)
  })

  it('enforces the total-character ceiling', () => {
    const items = Array.from({ length: MEMORY_MAX_ITEMS }, () => item('খ'.repeat(MEMORY_MAX_ITEM_CHARS)))
    const result = applyMemoryBudget(items)
    expect(result.chars).toBeLessThanOrEqual(MEMORY_MAX_TOTAL_CHARS)
    expect(result.kept.length).toBeLessThan(MEMORY_MAX_ITEMS)
  })

  it('keeps the strongest items — input order is preserved, not re-sorted', () => {
    const items = [item('best'), item('second'), item('third')]
    const result = applyMemoryBudget(items, { maxItems: 2 })
    expect(result.kept.map((k) => k.content)).toEqual(['best', 'second'])
  })

  it('stops at the total ceiling rather than letting a later short item leapfrog', () => {
    const result = applyMemoryBudget(
      [item('a'.repeat(80)), item('b'.repeat(80)), item('c')],
      { maxTotalChars: 100, maxItemChars: 200, maxItems: 10 },
    )
    expect(result.kept.map((k) => k.content[0])).toEqual(['a'])
  })

  it('handles an empty list', () => {
    const result = applyMemoryBudget([])
    expect(result.kept).toEqual([])
    expect(result.dropped).toBe(0)
    expect(result.chars).toBe(0)
  })
})

describe('withMemoryTimeout', () => {
  it('returns the real result when the work finishes in time', async () => {
    await expect(withMemoryTimeout(Promise.resolve(['fact']), [], 1000)).resolves.toEqual(['fact'])
  })

  it('falls back when the work overruns the budget', async () => {
    vi.useFakeTimers()
    try {
      const slow = new Promise<string[]>((resolve) => setTimeout(() => resolve(['late']), 10_000))
      const guarded = withMemoryTimeout(slow, [], 2500)
      await vi.advanceTimersByTimeAsync(2600)
      await expect(guarded).resolves.toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back on failure instead of throwing into the turn', async () => {
    await expect(
      withMemoryTimeout(Promise.reject(new Error('db down')), [] as string[], 1000),
    ).resolves.toEqual([])
  })

  it('swallows a late rejection so it cannot surface as an unhandled rejection', async () => {
    vi.useFakeTimers()
    try {
      const lateFail = new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('late')), 5_000))
      const guarded = withMemoryTimeout(lateFail, [], 1000)
      await vi.advanceTimersByTimeAsync(1100)
      await expect(guarded).resolves.toEqual([])
      await vi.advanceTimersByTimeAsync(5000)
    } finally {
      vi.useRealTimers()
    }
  })
})
