import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Window-based campaign metrics (live-found bug 2026-07-17): the owner paused
 * his campaign in the morning and "last 7 days performance" reported ৳0 —
 * fetchActiveCampaignMetrics() only reads currently-ACTIVE campaigns. The
 * window fetch must:
 *   1. Include campaigns that DELIVERED in the window regardless of status,
 *      carrying their TRUE current status (PAUSED stays PAUSED).
 *   2. Surface the account id + currency (silent-misconfig / ৳-mislabel class).
 *   3. Judge hasEnoughData against a currency-aware spend threshold —
 *      $11.48 (≈৳1400) must not be called thin against a ৳500 bar.
 */

vi.mock('@/agent/lib/fetch-retry', () => ({
  resilientFetch: (url: string) => mockFetch(url),
}))

let mockFetch: (url: string) => Promise<Response>

import { fetchCampaignMetricsWindow, minSpendForCurrency } from '../insights'

function jsonRes(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
}

beforeEach(() => {
  process.env.META_ADS_TOKEN = 'tok'
  process.env.META_AD_ACCOUNT_ID = 'act_1236291335314468'
  mockFetch = (url: string) => {
    if (url.includes('/insights')) {
      const range = decodeURIComponent(url)
      const isToday = /"since":"(\d{4}-\d{2}-\d{2})","until":"\1"/.test(range)
      if (isToday) return jsonRes({ data: [] }) // paused today → no delivery today
      return jsonRes({
        data: [
          {
            campaign_id: '120210000000000001',
            campaign_name: 'New Engagement Campaign-01-July 2026',
            spend: '11.48',
            impressions: '49804',
            clicks: '2387',
            ctr: '4.79',
            cpc: '0.0048',
          },
        ],
      })
    }
    if (url.includes('/campaigns')) {
      return jsonRes({
        data: [
          {
            id: '120210000000000001',
            name: 'New Engagement Campaign-01-July 2026',
            effective_status: 'PAUSED',
            objective: 'OUTCOME_ENGAGEMENT',
            daily_budget: '200',
          },
        ],
      })
    }
    if (url.includes('/adsets')) return jsonRes({ data: [] })
    // account meta (currency)
    return jsonRes({ currency: 'USD' })
  }
})
afterEach(() => {
  delete process.env.META_ADS_TOKEN
  delete process.env.META_AD_ACCOUNT_ID
})

describe('fetchCampaignMetricsWindow', () => {
  it('includes a campaign paused TODAY with its real window spend and TRUE status', async () => {
    const win = await fetchCampaignMetricsWindow(7)
    expect(win.accountId).toBe('act_1236291335314468')
    expect(win.currency).toBe('USD')
    expect(win.campaigns).toHaveLength(1)
    const c = win.campaigns[0]
    expect(c.name).toContain('New Engagement')
    expect(c.spendWeek).toBeCloseTo(11.48)
    expect(c.impressionsWeek).toBe(49804)
    expect(c.effectiveStatus).toBe('PAUSED') // never presented as running
    expect(c.spendToday).toBe(0)
  })

  it('marks $11.48 / 49.8k impressions as ENOUGH data under the USD threshold', async () => {
    const win = await fetchCampaignMetricsWindow(7)
    expect(win.campaigns[0].hasEnoughData).toBe(true)
  })
})

describe('minSpendForCurrency', () => {
  it('keeps ৳500 for BDT and a small-dollar bar for USD-class accounts', () => {
    expect(minSpendForCurrency('BDT')).toBe(500)
    expect(minSpendForCurrency('USD')).toBe(5)
    expect(minSpendForCurrency('EUR')).toBe(5)
  })
})
