/**
 * Owner incident 2026-07-26 — the opening line promised a card, the staging
 * tool was blocked, and the promise stayed on his screen unchallenged. The
 * speak-first line runs before any tool and survives every verification
 * rewrite, so it can only be CORRECTED, never rewritten.
 */
import { describe, it, expect } from 'vitest'
import { detectUncorrectedOpeningPromise, buildVerificationReminder } from '@/agent/lib/claim-verifier'

const hit = (opening: string, reply: string) => detectUncorrectedOpeningPromise(opening, reply).length > 0

describe('uncorrected opening-line promise', () => {
  const promise = 'বস, SEO ফিক্সগুলোর approval card বানাচ্ছি।'

  it('fires when the reply never mentions the missing card', () => {
    expect(hit(promise, 'অডিট শেষ — ৮৭টা product-এর meta ঠিক আছে।')).toBe(true)
  })

  it('stays quiet when the reply owns it', () => {
    expect(hit(promise, 'কার্ড তৈরি করতে পারিনি — ডুপ্লিকেট গার্ড আটকে দিয়েছে।')).toBe(false)
    expect(hit(promise, 'card আসেনি, tool ব্যর্থ হয়েছে। আবার চেষ্টা করব।')).toBe(false)
  })

  it('stays quiet when the opening line promised nothing', () => {
    expect(hit('বস, আগে ৮৯টা product page নিজে দেখে নিচ্ছি।', 'অডিট শেষ।')).toBe(false)
    expect(hit('', 'অডিট শেষ।')).toBe(false)
  })

  it('gives the head a correction instruction, not a rewrite instruction', () => {
    const reminder = buildVerificationReminder(detectUncorrectedOpeningPromise(promise, 'অডিট শেষ।'))
    expect(reminder).toContain('প্রথম লাইনে')
    expect(reminder).toContain('কার্ড তৈরি করতে পারিনি')
  })
})
