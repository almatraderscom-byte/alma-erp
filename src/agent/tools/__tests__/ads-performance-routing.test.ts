import { describe, it, expect } from 'vitest'
import { selectToolGroupsSync } from '@/agent/tools/select-tools'
import { matchIntentPacks } from '@/agent/tools/state-router'

/**
 * Ad-performance routing (live-hit 2026-07-17). The owner asked
 * "গত ৭ দিনের অ্যাড পারফরম্যান্স কেমন? খরচ, impressions, clicks, CTR সহ বলো।"
 * — the word "খরচ" pulled ONLY the `finance` group, so the head answered from
 * get_financial_health, which has no impressions/clicks/CTR, and truthfully said
 * "no readable data" while recommend_ad_actions had them all. Ad-metric phrasing
 * must reach the `growth`/`ads` tools.
 */

const OPTS = { personalMode: false, businessId: 'ALMA_LIFESTYLE' as const }

describe('selectToolGroupsSync — ad-metric phrasing pulls growth', () => {
  it('the exact live-failing message routes to BOTH finance and growth', () => {
    const { groups } = selectToolGroupsSync(
      'গত ৭ দিনের অ্যাড পারফরম্যান্স কেমন? খরচ, impressions, clicks, CTR সহ বলো।',
      OPTS,
    )
    expect(groups).toContain('growth') // has recommend_ad_actions (impressions/clicks/CTR)
    expect(groups).toContain('finance') // "খরচ" still legitimately pulls finance
  })

  it.each([
    'impressions clicks কত',
    'CTR কেমন',
    'অ্যাড পারফরম্যান্স দেখাও',
    'campaign এর reach কত',
    'ক্লিক আর ইমপ্রেশন দেখাও',
  ])('ad-metric phrasing "%s" pulls growth', (msg) => {
    expect(selectToolGroupsSync(msg, OPTS).groups).toContain('growth')
  })
})

describe('routeIntent — ads pack on metric words', () => {
  it.each([
    'গত ৭ দিনের অ্যাড পারফরম্যান্স কেমন? খরচ, impressions, clicks, CTR সহ বলো।',
    'CTR আর impressions কত?',
    'অ্যাড পারফরম্যান্স দেখাও',
  ])('"%s" hits the ads pack', (msg) => {
    expect(matchIntentPacks(msg)).toContain('ads')
  })
})
