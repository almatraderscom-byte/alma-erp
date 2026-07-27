/**
 * The checklist he can watch tick.
 *
 * Owner, 2026-07-27: he sees finished steps but never "৩/৫ শেষ", because the
 * plan in the thread was TEXT the model typed once. The plan rows themselves
 * have always ticked in the database — nothing carried them to the chat.
 *
 * Two things are worth locking: the headline says what he is waiting for (not
 * only how far along), and an unchanged plan does not re-render — a live element
 * that re-sends itself every round becomes wallpaper.
 */
import { describe, expect, it } from 'vitest'
import { buildPlanProgress, planProgressSignature } from '@/agent/lib/plan-progress'

const rows = (statuses: string[]) =>
  statuses.map((status, i) => ({ seq: i + 1, action: `ধাপ ${i + 1}`, status }))

describe('the headline', () => {
  it('counts finished steps in Bangla digits, like the rest of his thread', () => {
    const p = buildPlanProgress('p1', 'goal', rows(['done', 'done', 'running', 'pending', 'pending']))!
    expect(p.doneCount).toBe(2)
    expect(p.total).toBe(5)
    expect(p.headline).toContain('২/৫ ধাপ শেষ')
  })

  it('names what he is WAITING for, not just the ratio', () => {
    const p = buildPlanProgress('p1', 'goal', [
      { seq: 1, action: 'ক্রল চালু', status: 'done' },
      { seq: 2, action: 'ফল যাচাই', status: 'running' },
    ])!
    expect(p.headline).toContain('এখন: ফল যাচাই')
  })

  it('surfaces a stuck step instead of hiding it behind the count', () => {
    const p = buildPlanProgress('p1', 'goal', rows(['done', 'failed', 'pending']))!
    expect(p.headline).toContain('১টা আটকেছে')
  })

  it('drops the "এখন" clause when nothing is running rather than printing an empty one', () => {
    const p = buildPlanProgress('p1', 'goal', rows(['done', 'done']))!
    expect(p.headline).not.toContain('এখন')
  })

  it('orders by seq even when the rows arrive shuffled', () => {
    const p = buildPlanProgress('p1', 'goal', [
      { seq: 3, action: 'তিন', status: 'pending' },
      { seq: 1, action: 'এক', status: 'done' },
      { seq: 2, action: 'দুই', status: 'running' },
    ])!
    expect(p.steps.map((s) => s.seq)).toEqual([1, 2, 3])
  })

  it('is null with no steps — an empty checklist is worse than none', () => {
    expect(buildPlanProgress('p1', 'goal', [])).toBeNull()
    expect(buildPlanProgress('', 'goal', rows(['pending']))).toBeNull()
  })
})

describe('only re-render when something really moved', () => {
  it('same statuses → same signature, so the component is not re-sent', () => {
    const a = buildPlanProgress('p1', 'g', rows(['done', 'running', 'pending']))
    const b = buildPlanProgress('p1', 'g', rows(['done', 'running', 'pending']))
    expect(planProgressSignature(a)).toBe(planProgressSignature(b))
  })

  it('a step advancing changes the signature', () => {
    const before = buildPlanProgress('p1', 'g', rows(['done', 'running', 'pending']))
    const after = buildPlanProgress('p1', 'g', rows(['done', 'done', 'running']))
    expect(planProgressSignature(before)).not.toBe(planProgressSignature(after))
  })

  it('an unrelated write (goal text, cost accounting) does NOT re-render', () => {
    // The signature is the status vector on purpose: `updatedAt` moves on a plan
    // row for reasons that have nothing to do with the checklist.
    const a = buildPlanProgress('p1', 'goal one', rows(['done', 'running']))
    const b = buildPlanProgress('p1', 'goal two', rows(['done', 'running']))
    expect(planProgressSignature(a)).toBe(planProgressSignature(b))
  })
})
