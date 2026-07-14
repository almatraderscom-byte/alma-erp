import { describe, expect, it } from 'vitest'
import {
  shouldNudgeAdapterIntent,
  shouldNudgeZeroToolIntent,
} from '../turn-loop-policy'

describe('turn-loop policy — no hidden duplicate work', () => {
  it('does not turn an owner-directed question into another execution', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'ALMA Companion থেকে এখন কোনো heartbeat পাচ্ছি না। আর কিছু করব কি?',
      toolRecords: [{ status: 'error' }],
    })).toBe(false)
  })

  it('stops after any honest blocked/offline response', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'Chrome এখন offline, তাই কাজটি করতে পারিনি। আবার চেষ্টা করব।',
      toolRecords: [{ status: 'error' }],
    })).toBe(false)
  })

  it('stops after the latest tool failed even when the wording promises action', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'এখন অন্যভাবে চেষ্টা করব।',
      toolRecords: [{ status: 'success' }, { status: 'error' }],
    })).toBe(false)
  })

  it('allows one real next-step nudge after a successful tool', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'প্রথম পেজ দেখা হয়েছে। এখন Manual destination সিলেক্ট করব।',
      toolRecords: [{ status: 'success' }],
    })).toBe(true)
  })

  it('does not nudge when an ask card already hands control to the owner', () => {
    expect(shouldNudgeAdapterIntent({
      text: 'অনুমতি পেলে পরের ধাপ করব।',
      toolRecords: [{ status: 'success' }],
      hasAskCard: true,
    })).toBe(false)
  })

  it('applies the same question/failure rule to the zero-tool head path', () => {
    expect(shouldNudgeZeroToolIntent({ text: 'আমি আগে চেক করি—আপনি চান কি?' })).toBe(false)
    expect(shouldNudgeZeroToolIntent({ text: 'সংযোগ নেই, তাই চেক করতে পারছি না।' })).toBe(false)
    expect(shouldNudgeZeroToolIntent({ text: 'একটু দাঁড়ান, let me check the record.' })).toBe(true)
  })
})
