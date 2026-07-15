import { describe, it, expect } from 'vitest'
import { buildMessagesPagePlan, MESSAGES_PAGE_MAX } from '@/agent/lib/messages-page'

/** Roadmap 4.1 — the message pagination/delta query plan. */
describe('Phase 4 — buildMessagesPagePlan', () => {
  it('no params = legacy full ascending history', () => {
    expect(buildMessagesPagePlan({})).toEqual({ fetchDescThenReverse: false })
  })

  it('limit alone = latest-N window (desc fetch, reversed to asc)', () => {
    expect(buildMessagesPagePlan({ limit: '50' })).toEqual({ take: 50, fetchDescThenReverse: true })
  })

  it('caps runaway limits and rejects junk', () => {
    expect(buildMessagesPagePlan({ limit: '99999' }).take).toBe(MESSAGES_PAGE_MAX)
    expect(buildMessagesPagePlan({ limit: 'abc' })).toEqual({ fetchDescThenReverse: false })
    expect(buildMessagesPagePlan({ limit: '-5' })).toEqual({ fetchDescThenReverse: false })
  })

  it('before anchor pages OLDER history above the anchor', () => {
    const anchor = new Date('2026-07-14T10:00:00Z')
    const plan = buildMessagesPagePlan({ limit: '40', beforeCreatedAt: anchor })
    expect(plan.createdAt).toEqual({ lt: anchor })
    expect(plan.take).toBe(40)
    expect(plan.fetchDescThenReverse).toBe(true)
  })

  it('since = ascending delta poll, wins over before', () => {
    const plan = buildMessagesPagePlan({
      since: '2026-07-14T10:00:00Z',
      beforeCreatedAt: new Date('2026-07-14T09:00:00Z'),
    })
    expect(plan.createdAt).toEqual({ gt: new Date('2026-07-14T10:00:00Z') })
    expect(plan.fetchDescThenReverse).toBe(false)
  })

  it('malformed since falls through (never a broken filter)', () => {
    expect(buildMessagesPagePlan({ since: 'not-a-date' })).toEqual({ fetchDescThenReverse: false })
  })
})
