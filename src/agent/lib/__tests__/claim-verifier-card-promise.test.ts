/**
 * Owner incident 2026-07-26 — the head wrote "card বানাচ্ছি", draft_seo_fixes
 * was blocked by the duplicate guard, no card was ever created, and nothing
 * caught the claim. The detector knew "তৈরি করছি" but not its everyday synonym.
 */
import { describe, it, expect } from 'vitest'
import { countStagedCards, detectMissingCardViolation } from '@/agent/lib/claim-verifier'

const caught = (s: string) => detectMissingCardViolation(s).length > 0

describe('card-promise detection', () => {
  it('catches the বানা- family the owner actually saw', () => {
    expect(caught('বস, SEO ফিক্সের approval card বানাচ্ছি।')).toBe(true)
    expect(caught('card বানাচ্ছি')).toBe(true)
    expect(caught('অনুমোদন কার্ড বানালাম')).toBe(true)
    expect(caught('approval card বানিয়েছি')).toBe(true)
    expect(caught('একটা approval card বানাব')).toBe(true)
    expect(caught('কার্ড বানানো হয়েছে')).toBe(true)
  })

  it('catches the জিজ্ঞেস family — sim incident 2026-08-15 (Build 105 checklist)', () => {
    // Luna's exact flake: promised the multi-question card, never called ask_user.
    expect(caught('বস, সাপ্তাহিক রিপোর্ট বানাতে কোন সময়সীমা ও কোন বিষয়গুলো রাখব—এটাই নিশ্চিত করা দরকার; এক কার্ডে জিজ্ঞেস করছি।')).toBe(true)
    expect(caught('এক কার্ডে জিজ্ঞেস করছি')).toBe(true)
    expect(caught('কার্ডে জিজ্ঞাসা করব')).toBe(true)
    expect(caught('প্রশ্ন কার্ডে জানতে চাইছি')).toBe(true)
    expect(caught('asking in one card')).toBe(true)
  })

  it('still catches what it caught before', () => {
    expect(caught('approval card পাঠাচ্ছি')).toBe(true)
    expect(caught('অনুমোদন কার্ড তৈরি করছি')).toBe(true)
    expect(caught('confirm card নিচে দিলাম')).toBe(true)
    expect(caught('card তৈরি হয়েছে')).toBe(true)
  })

  it('never fires on an honest admission', () => {
    expect(caught('কার্ড তৈরি করতে পারিনি — ডুপ্লিকেট গার্ড আটকে দিয়েছে।')).toBe(false)
    expect(caught('approval card বানাতে পারিনি')).toBe(false)
    expect(caught('card আসেনি, কারণ tool ব্যর্থ হয়েছে')).toBe(false)
    expect(caught('কার্ড তৈরি হয়নি')).toBe(false)
  })

  it('does not fire on prose that only mentions a card', () => {
    expect(caught('আগের approval card-টা আপনি কালকে approve করেছিলেন।')).toBe(false)
    expect(caught('SEO অডিট শেষ — ৮৭টা product ঠিক আছে।')).toBe(false)
  })
})

describe('countStagedCards — a pending action IS a card', () => {
  const ok = (output: Record<string, unknown> | null) => ({ status: 'success' as const, output })

  it('counts a successful staging call', () => {
    expect(countStagedCards([ok({ data: { pendingActionId: 'a1', count: 3 } })])).toBe(1)
    expect(countStagedCards([ok({ data: { askCardId: 'q1' } })])).toBe(1)
  })

  it('does NOT count a failed staging call', () => {
    expect(countStagedCards([{ status: 'error', output: null }])).toBe(0)
    expect(countStagedCards([{ status: 'error', output: { data: { pendingActionId: 'a1' } } }])).toBe(0)
  })

  it('does not count ordinary read results', () => {
    expect(countStagedCards([ok({ data: { products: 89 } })])).toBe(0)
    expect(countStagedCards([ok(null)])).toBe(0)
  })

  it('accepts an id at the top level of the result too', () => {
    expect(countStagedCards([ok({ pendingActionId: 'a1' })])).toBe(1)
  })
})
