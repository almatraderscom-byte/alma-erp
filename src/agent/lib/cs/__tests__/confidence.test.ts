import { describe, it, expect } from 'vitest'
import { scoreCsReplyConfidence, csConfidenceThreshold } from '@/agent/lib/cs/confidence'
import { detectHardStopCategory, hardStopBlocksAuto } from '@/agent/lib/cs/hard-stops'

describe('detectHardStopCategory', () => {
  it('flags refund requests', () => {
    expect(detectHardStopCategory('ami refund chai')).toBe('refund')
    expect(hardStopBlocksAuto('refund')).toBe(true)
  })

  it('flags complaints', () => {
    expect(detectHardStopCategory('this is a scam complaint')).toBe('complaint')
  })

  it('flags price negotiation', () => {
    expect(detectHardStopCategory('discount দিলে নিব')).toBe('price_negotiation')
  })

  it('allows normal product questions', () => {
    expect(detectHardStopCategory('এই পাঞ্জাবির সাইজ L আছে?')).toBeNull()
  })
})

describe('scoreCsReplyConfidence', () => {
  it('escalates on handoff', () => {
    const r = scoreCsReplyConfidence({
      userText: 'help',
      parts: [{ type: 'text', text: 'ok' }],
      handedOff: true,
    })
    expect(r.escalate).toBe(true)
    expect(r.score).toBe(0)
  })

  it('passes confident product reply with tool use', () => {
    const r = scoreCsReplyConfidence({
      userText: 'price koto?',
      parts: [{ type: 'text', text: 'ভাইয়া, এই পাঞ্জাবির দাম ৳২,৫০০। স্টকে M, L আছে।' }],
      handedOff: false,
      hadToolUse: true,
    })
    expect(r.score).toBeGreaterThanOrEqual(csConfidenceThreshold())
    expect(r.escalate).toBe(false)
  })

  it('escalates uncertain reply below threshold', () => {
    const r = scoreCsReplyConfidence({
      userText: 'eta ki?',
      parts: [{ type: 'text', text: 'জানি না' }],
      handedOff: false,
    })
    expect(r.escalate).toBe(true)
  })

  it('hard-stop categories never pass auto gate (checked upstream)', () => {
    expect(hardStopBlocksAuto(detectHardStopCategory('refund pls'))).toBe(true)
  })
})
