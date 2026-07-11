import { describe, it, expect } from 'vitest'
import { isEphemeralDayFact, resolveMemoryExpiry } from '@/agent/lib/agent-memory'

describe('memory expiry hard rules (owner rule 2026-07-08)', () => {
  it('classifies day-scoped facts as ephemeral', () => {
    // The owner's own example — today's office holiday.
    expect(isEphemeralDayFact('বস 8 July 2026 (বুধবার) অফিস ছুটি দিয়েছেন — আজকের জন্য সব অফিস কাজ বন্ধ রাখতে হবে।')).toBe(true)
    expect(isEphemeralDayFact('আজ অফিস বন্ধ থাকবে')).toBe(true)
    expect(isEphemeralDayFact('ajke office chuti')).toBe(true)
    // Daily salah logs — one row per waqt per day was piling up as permanent.
    expect(isEphemeralDayFact('2026-07-05 তারিখে মাগরিব নামাজ Boss একা পড়েছেন।')).toBe(true)
    expect(isEphemeralDayFact('রাতের সালাহ মুহাসাবা (2026-07-06) — নিজের প্রতিফলন')).toBe(true)
  })

  it('keeps standing facts permanent', () => {
    expect(isEphemeralDayFact('নামাজের রিমাইন্ডার কখনোই বন্ধ হবে না, এটা সারা জীবনের স্থায়ী নিয়ম।')).toBe(false)
    expect(isEphemeralDayFact('বসের নিজ নাম্বার (01779640373) বা Alma Traders নামে অর্ডারগুলো টেস্ট অর্ডার')).toBe(false)
    expect(isEphemeralDayFact('বসের পছন্দ: ask_user tool ব্যবহার করে প্রশ্ন কার্ড পাঠানো')).toBe(false)
  })

  it('applies the expiry floor even when the caller claims permanent', () => {
    // Explicit null (model said "permanent") must NOT override the day-scope rule.
    const floored = resolveMemoryExpiry('আজ অফিস ছুটি — সব কাজ বন্ধ', { pinned: false, explicit: null })
    expect(floored).toBeInstanceOf(Date)
    expect((floored as Date).getTime()).toBeGreaterThan(Date.now())
    // ...but within ~4 days (end of Dhaka day + 2-day grace).
    expect((floored as Date).getTime()).toBeLessThan(Date.now() + 4 * 24 * 3600_000)
  })

  it('explicit expiry date always wins', () => {
    const explicit = new Date(Date.now() + 30 * 24 * 3600_000)
    expect(resolveMemoryExpiry('আজ অফিস ছুটি', { pinned: false, explicit })).toBe(explicit)
  })

  it('pinned facts are exempt from the auto-expiry floor', () => {
    expect(resolveMemoryExpiry('আজ অফিস ছুটি', { pinned: true, explicit: null })).toBeNull()
  })

  it('normal business facts stay permanent by default', () => {
    expect(resolveMemoryExpiry('স্টক ম্যানেজমেন্টের জন্য আলাদা সফটওয়্যার আছে', { pinned: false })).toBeNull()
  })
})
