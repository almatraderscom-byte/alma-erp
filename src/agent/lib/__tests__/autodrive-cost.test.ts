/**
 * S0 cost accounting. Two defects, both of which made the engine strangle itself:
 *  - whole-taka rounding billed 1৳ for every sub-taka turn;
 *  - the "daily" spend summed each plan's LIFETIME cost, so yesterday's spend was
 *    charged again today (and again the day after).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  agentPlan: { aggregate: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

import {
  usdToTaka,
  usdToMilliTaka,
  milliTakaToTaka,
  getTodayAutodriveSpendMilliTaka,
  getTodayAutodriveSpendTaka,
} from '@/agent/lib/autodrive-config'

beforeEach(() => vi.clearAllMocks())

describe('autodrive cost accounting', () => {
  it('milli-taka keeps sub-taka turns honest where whole taka rounded them up', () => {
    // A cheap step turn: $0.0008 ≈ 0.1৳. The cap arithmetic must see 0.1৳,
    // not the 1৳ the old rounding charged — 79 such steps used to "spend" 79৳.
    expect(usdToTaka(0.0008)).toBe(1)
    expect(usdToMilliTaka(0.0008)).toBe(100)
    expect(milliTakaToTaka(100)).toBe(0)
  })

  it('still rounds UP, so spend is never undercounted', () => {
    expect(usdToMilliTaka(0.0000001)).toBe(1)
    expect(usdToMilliTaka(0)).toBe(0)
    expect(usdToMilliTaka(-5)).toBe(0)
    expect(usdToMilliTaka(Number.NaN)).toBe(0)
  })

  it('daily spend counts only plans stamped with TODAY (Asia/Dhaka)', async () => {
    mockPrisma.agentPlan.aggregate.mockResolvedValue({ _sum: { costMilliTakaDay: 12_400 } })

    const now = new Date('2026-07-24T19:00:00Z') // already the 25th in Dhaka
    expect(await getTodayAutodriveSpendMilliTaka(now)).toBe(12_400)
    expect(await getTodayAutodriveSpendTaka(now)).toBe(12)

    const where = mockPrisma.agentPlan.aggregate.mock.calls[0][0].where
    expect(where).toEqual({ costDay: '2026-07-25' })
    // The lifetime column must not be what the cap reads.
    const sum = mockPrisma.agentPlan.aggregate.mock.calls[0][0]._sum
    expect(sum).toEqual({ costMilliTakaDay: true })
  })

  it('reports zero when no plan has spent today', async () => {
    mockPrisma.agentPlan.aggregate.mockResolvedValue({ _sum: { costMilliTakaDay: null } })
    expect(await getTodayAutodriveSpendTaka(new Date('2026-07-25T06:00:00Z'))).toBe(0)
  })
})
