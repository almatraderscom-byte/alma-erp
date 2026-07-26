/**
 * Owner incident 2026-07-26 — the head wrote "card বানাচ্ছি", draft_seo_fixes
 * was blocked by the duplicate guard, no card was ever created, and nothing
 * caught the claim. The detector knew "তৈরি করছি" but not its everyday synonym.
 */
import { describe, it, expect } from 'vitest'
import { detectMissingCardViolation } from '@/agent/lib/claim-verifier'

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
