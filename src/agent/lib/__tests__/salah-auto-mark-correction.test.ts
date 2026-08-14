import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), upsert: vi.fn() }))

vi.mock('@/lib/prisma', () => ({
  prisma: { agentSalahRecord: { findMany: mocks.findMany, upsert: mocks.upsert } },
}))

import { applySalahAutoMarkFromUserTexts } from '@/agent/lib/salah-auto-mark'
import { dhakaMidnightUtc, todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

// A live-call correction scenario (Codex P1 rounds 5–6, PR #762): the owner
// confirms Isha, then corrects himself seconds later WITHOUT naming the waqt.
describe('spoken salah correction semantics', () => {
  const now = new Date('2026-08-14T15:30:00Z') // 21:30 Dhaka — Isha window
  const todayYmd = todayYmdDhaka(now)

  function ishaRecord(status: string, confirmedAt: Date | null) {
    return {
      waqt: 'isha',
      status,
      windowStart: new Date('2026-08-14T14:50:00Z'),
      windowEnd: new Date('2026-08-14T22:00:00Z'),
      confirmedAt,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.upsert.mockResolvedValue({})
  })

  it('redirects a waqt-less opposite-kind correction to the just-confirmed record', async () => {
    mocks.findMany
      .mockResolvedValueOnce([ishaRecord('prayed_on_time', new Date(now.getTime() - 30_000))])
      .mockResolvedValueOnce([]) // yesterday
    const result = await applySalahAutoMarkFromUserTexts(
      ['না না, নামাজ পড়িনি'], now, { allowSettledCorrection: true },
    )
    expect(result.marked).toEqual([
      expect.objectContaining({ date: todayYmd, waqt: 'isha', status: 'missed' }),
    ])
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { date_waqt: { date: dhakaMidnightUtc(todayYmd), waqt: 'isha' } },
      update: expect.objectContaining({ status: 'missed' }),
    }))
  })

  it('does not churn a settled record when the repeated kind is unchanged', async () => {
    mocks.findMany
      .mockResolvedValueOnce([ishaRecord('prayed_on_time', new Date(now.getTime() - 30_000))])
      .mockResolvedValueOnce([])
    const result = await applySalahAutoMarkFromUserTexts(
      ['ইশার নামাজ পড়েছি'], now, { allowSettledCorrection: true },
    )
    expect(result.marked).toEqual([])
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('keeps the chat default: settled records are never overwritten', async () => {
    mocks.findMany
      .mockResolvedValueOnce([ishaRecord('prayed_on_time', new Date(now.getTime() - 30_000))])
      .mockResolvedValueOnce([])
    const result = await applySalahAutoMarkFromUserTexts(['ইশার নামাজ পড়িনি'], now)
    expect(result.marked).toEqual([])
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
})
