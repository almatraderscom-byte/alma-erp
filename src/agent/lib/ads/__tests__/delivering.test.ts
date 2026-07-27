/**
 * ADS-2 phase A — "কয়টা ক্যাম্পেইন চলছে".
 *
 * Boss counted 2 in Ads Manager on 2026-07-27; the tool reported 4. Neither was
 * lying: we counted campaign-level `effective_status === ACTIVE`, which stays
 * ACTIVE while every ad set and ad under it is paused. One of the four had spent
 * $0.00 with 0 impressions for a week and was still in the running count.
 *
 * His count is the one that matters, because his count is the one that spends
 * money.
 */
import { describe, expect, it } from 'vitest'
import { deliveringFrom, type CampaignStructure } from '@/agent/lib/ads/insights'

const structure = (rows: Record<string, [number, number]>) =>
  new Map<string, CampaignStructure>(
    Object.entries(rows).map(([id, [adSets, ads]]) => [
      id,
      { activeAdSets: adSets, activeAds: ads, adSetDailyBudget: 0, known: true },
    ]),
  )

describe('delivering', () => {
  it('needs a live ad set AND a live ad, not just a live campaign', () => {
    const s = structure({ live: [1, 2], noAds: [1, 0], noAdSets: [0, 3] })
    expect(deliveringFrom(s, 'live', true).delivering).toBe(true)
    expect(deliveringFrom(s, 'noAds', true).delivering).toBe(false)
    expect(deliveringFrom(s, 'noAdSets', true).delivering).toBe(false)
  })

  it('a paused campaign never delivers, however alive its children look', () => {
    const s = structure({ c: [4, 9] })
    expect(deliveringFrom(s, 'c', false).delivering).toBe(false)
  })

  it('a campaign with no ad sets at all is the $0.00 shell Boss does not count', () => {
    const s = structure({ other: [1, 1] })
    const r = deliveringFrom(s, 'empty-campaign', true)
    expect(r).toEqual({ activeAdSets: 0, activeAds: 0, delivering: false })
  })

  it('reproduces his account: 4 campaign-level ACTIVE, 2 actually running', () => {
    // Two with live children, one whose ad set is off, one empty shell.
    const s = structure({ july17: [1, 1], april30: [1, 2], april13: [0, 0] })
    const campaigns = ['july17', 'april30', 'april13', 'newEngagement']
    const delivering = campaigns.filter((id) => deliveringFrom(s, id, true).delivering)
    expect(delivering).toEqual(['july17', 'april30'])
  })

  it('fails SAFE: with no structure data it answers as before, not "all stopped"', () => {
    // A Graph hiccup must never be rendered as "every campaign is off" — that
    // reads as an outage and would invite exactly the wrong action.
    const empty = new Map<string, CampaignStructure>()
    expect(deliveringFrom(empty, 'anything', true).delivering).toBe(true)
    expect(deliveringFrom(empty, 'anything', false).delivering).toBe(false)
  })
})
