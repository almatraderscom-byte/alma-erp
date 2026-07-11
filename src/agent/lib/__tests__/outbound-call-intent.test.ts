import { describe, it, expect } from 'vitest'
import {
  detectOutboundCallIntent,
  isOutboundCallIntent,
  textHasBdNumber,
  buildOutboundCallIntakeBlock,
} from '@/agent/lib/outbound-call-intent'

describe('detectOutboundCallIntent', () => {
  // The owner's real messages from the bug reports (Banglish + Bangla).
  it('detects the call instruction WITHOUT a number yet (two-message flow)', () => {
    const text =
      'আচ্ছা আমি তোমাকে একটা নাম্বার দিবো, বাংলাদেশের নাম্বার। তুমি সেই নাম্বারে কল দিবে এবং কল দিয়ে বলবে, আমি মারুফ বসের এজেন্ট। ইলেভেন লাবস ভয়েস ইউজ করবে। আমি তোমাকে নাম্বারটা এখন দিচ্ছি।'
    const r = detectOutboundCallIntent(text)
    expect(r.isCall).toBe(true)
    expect(r.hasNumber).toBe(false)
  })

  it('detects the Banglish call instruction WITH a number', () => {
    const text =
      'Tmi amr ek boro bhai er number e call korbe +8801949489548 take bolbe ami maruf sir er agent. Elevenlabs er voice use korbe.'
    const r = detectOutboundCallIntent(text)
    expect(r.isCall).toBe(true)
    expect(r.hasNumber).toBe(true)
  })

  it('detects "ওকে কল দিয়ে বলো" (call him and say)', () => {
    expect(isOutboundCallIntent('ওকে কল দিয়ে বলো আমি আসছি')).toBe(true)
  })

  it('does NOT trip on a "remind me / call me later" note (no say-verb, no number)', () => {
    expect(isOutboundCallIntent('15 minute por amake call dio')).toBe(false)
    expect(isOutboundCallIntent('আমাকে একটু পরে কল করতে মনে করিয়ে দিও')).toBe(false)
  })

  it('does NOT trip on unrelated chat', () => {
    expect(isOutboundCallIntent('aj koto sale holo?')).toBe(false)
    expect(isOutboundCallIntent('স্টক কত আছে?')).toBe(false)
  })
})

describe('textHasBdNumber', () => {
  it('matches +880 and local 01 numbers', () => {
    expect(textHasBdNumber('+8801949489548')).toBe(true)
    expect(textHasBdNumber('01949489548 ekhane call koro')).toBe(true)
  })
  it('ignores short / non-BD digit runs', () => {
    expect(textHasBdNumber('231 bestseller 40 pcs')).toBe(false)
  })
})

describe('buildOutboundCallIntakeBlock', () => {
  it('tells the head to call now when a number is present', () => {
    const b = buildOutboundCallIntakeBlock(true)
    expect(b).toMatch(/outbound_phone_call/)
    expect(b).toMatch(/NOT a reminder/i)
  })
  it('tells the head to ask for the number when absent', () => {
    const b = buildOutboundCallIntakeBlock(false)
    expect(b).toMatch(/ask him to send the number/i)
    expect(b).toMatch(/Do NOT set any reminder/i)
  })
})
