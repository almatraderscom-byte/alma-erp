import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the data sources + notify BEFORE importing the module under test.
const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findUnique: vi.fn(), upsert: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const mockPerf = vi.hoisted(() => ({ computeStaffPerformance: vi.fn() }))
vi.mock('@/agent/lib/office-performance', () => mockPerf)

const mockCoach = vi.hoisted(() => ({ computeStaffTrend: vi.fn() }))
vi.mock('@/agent/lib/office-coaching', () => mockCoach)

const mockNotify = vi.hoisted(() => ({ notifyOwner: vi.fn().mockResolvedValue({ channels: [], statuses: {} }) }))
vi.mock('@/agent/lib/notify-owner', () => mockNotify)

// currentWeekStart → a fixed Monday (2026-06-29 anchors the "current" week).
vi.mock('@/agent/lib/office-award', () => ({
  currentWeekStart: () => new Date('2026-06-29T00:00:00Z'),
}))

import {
  buildWeeklyReportCard,
  runWeeklyReportCardSend,
  WEEKLY_CARD_KEY_PREFIX,
} from '@/agent/lib/weekly-report-card'

type Perf = {
  staffId: string
  staffName: string
  assigned: number
  done: number
  onTime: number
  late: number
  onTimeRate: number | null
  redo: number
  escalated: number
  autoVerified: number
  accepted: number
  score: number
}
function perf(p: Partial<Perf> & { staffId: string; staffName: string }): Perf {
  return {
    assigned: 0, done: 0, onTime: 0, late: 0, onTimeRate: null, redo: 0,
    escalated: 0, autoVerified: 0, accepted: 0, score: 0, ...p,
  }
}
function trend(staffId: string, staffName: string, direction: 'up' | 'down' | 'flat', deltaScore: number, coachLine: string) {
  return {
    staffId, staffName, direction, deltaScore, deltaDone: 0,
    thisWeek: { done: 0, onTimeRate: null, redo: 0, score: 0 },
    lastWeek: { done: 0, onTimeRate: null, redo: 0, score: 0 },
    coachLine,
  }
}

const MON = new Date('2026-06-29T06:00:00Z') // Dhaka Monday noon
const TUE = new Date('2026-06-30T06:00:00Z') // Dhaka Tuesday noon

describe('buildWeeklyReportCard — consolidated weekly rollup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('aggregates team totals and picks the standout + biggest improver', async () => {
    mockPerf.computeStaffPerformance.mockResolvedValue([
      perf({ staffId: 'a', staffName: 'Eyafi', assigned: 5, done: 5, onTime: 4, late: 1, onTimeRate: 80, score: 52 }),
      perf({ staffId: 'b', staffName: 'Rakib', assigned: 3, done: 2, onTime: 1, late: 1, onTimeRate: 50, redo: 2, score: 18 }),
    ])
    mockCoach.computeStaffTrend.mockResolvedValue([
      trend('a', 'Eyafi', 'up', 12, '📈 Eyafi ভালো করছে'),
      trend('b', 'Rakib', 'down', -6, '🔻 Rakib পিছিয়ে'),
    ])

    const card = await buildWeeklyReportCard({ businessId: 'ALMA_LIFESTYLE' })

    expect(card.staffCount).toBe(2)
    expect(card.totals.assigned).toBe(8)
    expect(card.totals.done).toBe(7)
    // team on-time = onTime 5 / (onTime 5 + late 2) = 71%
    expect(card.totals.onTimeRate).toBe(71)
    expect(card.topPerformer?.staffName).toBe('Eyafi')
    expect(card.biggestImprover).toEqual({ staffName: 'Eyafi', deltaScore: 12 })
    // Rakib flagged for rework.
    expect(card.needsAttention.some((a) => a.staffName === 'Rakib' && /redo/.test(a.reason))).toBe(true)
    expect(card.summaryBangla).toContain('সাপ্তাহিক স্টাফ রিপোর্ট-কার্ড')
    expect(card.summaryBangla).toContain('Eyafi')
  })

  it('reports the JUST-FINISHED week by default (currentWeekStart − 7d)', async () => {
    mockPerf.computeStaffPerformance.mockResolvedValue([])
    mockCoach.computeStaffTrend.mockResolvedValue([])
    await buildWeeklyReportCard({ businessId: 'ALMA_LIFESTYLE' })
    const passed = mockPerf.computeStaffPerformance.mock.calls[0][1] as Date
    expect(passed.toISOString()).toBe('2026-06-22T00:00:00.000Z') // 2026-06-29 minus 7 days
  })

  it('no attention items → reassuring "all clear" line', async () => {
    mockPerf.computeStaffPerformance.mockResolvedValue([
      perf({ staffId: 'a', staffName: 'Eyafi', assigned: 4, done: 4, onTime: 4, onTimeRate: 100, score: 40 }),
    ])
    mockCoach.computeStaffTrend.mockResolvedValue([trend('a', 'Eyafi', 'flat', 0, '✅ স্থিতিশীল')])
    const card = await buildWeeklyReportCard({})
    expect(card.needsAttention).toHaveLength(0)
    expect(card.summaryBangla).toContain('বড় সমস্যা নেই')
  })
})

describe('runWeeklyReportCardSend — Monday auto-delivery, idempotent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.agentKvSetting.upsert.mockResolvedValue({})
  })

  it('does NOT send on a non-Monday', async () => {
    const res = await runWeeklyReportCardSend({ now: TUE })
    expect(res.sent).toBe(false)
    expect(res.detail).toBe('not_monday')
    expect(mockNotify.notifyOwner).not.toHaveBeenCalled()
  })

  it('sends on Monday when there is activity and no prior send', async () => {
    mockPerf.computeStaffPerformance.mockResolvedValue([
      perf({ staffId: 'a', staffName: 'Eyafi', assigned: 5, done: 5, onTime: 5, onTimeRate: 100, score: 50 }),
    ])
    mockCoach.computeStaffTrend.mockResolvedValue([trend('a', 'Eyafi', 'up', 10, '📈 ভালো')])
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)

    const res = await runWeeklyReportCardSend({ now: MON })
    expect(res.sent).toBe(true)
    expect(mockNotify.notifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 1, category: 'report' }),
    )
    expect(mockPrisma.agentKvSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: `${WEEKLY_CARD_KEY_PREFIX}ALMA_LIFESTYLE:2026-06-22` } }),
    )
  })

  it('does NOT re-send when this week was already delivered', async () => {
    mockPerf.computeStaffPerformance.mockResolvedValue([
      perf({ staffId: 'a', staffName: 'Eyafi', assigned: 5, done: 5, score: 50 }),
    ])
    mockCoach.computeStaffTrend.mockResolvedValue([trend('a', 'Eyafi', 'up', 10, '📈 ভালো')])
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue({ value: '2026-06-29T03:00:00Z' })

    const res = await runWeeklyReportCardSend({ now: MON })
    expect(res.sent).toBe(false)
    expect(res.detail).toBe('already_sent')
    expect(mockNotify.notifyOwner).not.toHaveBeenCalled()
  })

  it('skips a week with zero staff activity', async () => {
    mockPerf.computeStaffPerformance.mockResolvedValue([])
    mockCoach.computeStaffTrend.mockResolvedValue([])
    const res = await runWeeklyReportCardSend({ now: MON })
    expect(res.sent).toBe(false)
    expect(res.detail).toBe('no_activity')
    expect(mockNotify.notifyOwner).not.toHaveBeenCalled()
  })

  it('force bypasses the Monday gate (owner "send it now")', async () => {
    mockPerf.computeStaffPerformance.mockResolvedValue([
      perf({ staffId: 'a', staffName: 'Eyafi', assigned: 2, done: 2, score: 20 }),
    ])
    mockCoach.computeStaffTrend.mockResolvedValue([trend('a', 'Eyafi', 'flat', 0, '✅ ok')])
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
    const res = await runWeeklyReportCardSend({ now: TUE, force: true })
    expect(res.sent).toBe(true)
    expect(mockNotify.notifyOwner).toHaveBeenCalledTimes(1)
  })
})
