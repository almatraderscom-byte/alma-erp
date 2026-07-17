import { describe, it, expect } from 'vitest'
import { formatFinancialBrief, type FinancialHealth } from '../financial-intelligence'

/**
 * Currency guard (live-found 2026-07-17): the ad account bills in USD, but ad
 * spend was rounded by whole-taka roundMoney() and subtracted from taka revenue
 * inside netProfit — the agent told the owner "ad spend ৳12, net -৳1,112" for a
 * real $11.49 week. Foreign-currency ad spend must be reported in its own
 * currency and kept OUT of the taka maths, visibly.
 */
function health(over: Partial<FinancialHealth> = {}): FinancialHealth {
  return {
    period: '2026-07-10 → 2026-07-17',
    days: 7,
    revenue: 1620,
    expenses: { total: 500, byCategory: {} },
    adSpend: 11.49,
    adSpendCurrency: 'USD',
    adSpendInNet: false,
    grossProfit: null,
    netProfit: 1120,
    marginPct: 69.1,
    trends: {},
    flags: [],
    costDataMissing: true,
    costDataCoveragePct: 0,
    productBreakdown: [],
    channelBreakdown: [],
    subscriptionNote: null,
    notes: [],
    ...over,
  }
}

describe('formatFinancialBrief — ad spend currency', () => {
  it('labels USD ad spend with $ and says it is outside net (never "৳11.49")', () => {
    const brief = formatFinancialBrief(health())
    expect(brief).toContain('অ্যাড: $11.49')
    expect(brief).toContain('নেট হিসাবের বাইরে')
    expect(brief).not.toContain('অ্যাড: ৳11.49')
  })

  it('keeps the plain ৳ label for a genuinely taka account, inside net', () => {
    const brief = formatFinancialBrief(health({ adSpend: 1400, adSpendCurrency: 'BDT', adSpendInNet: true }))
    expect(brief).toContain('অ্যাড: ৳1400')
    expect(brief).not.toContain('নেট হিসাবের বাইরে')
  })
})
