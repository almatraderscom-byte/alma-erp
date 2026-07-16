import { describe, it, expect } from 'vitest'

// ── Ask-guard (2026-07-16): prose choice-question without ask_user card ──────
import { detectMissingAskViolation } from '../claim-verifier'

describe('detectMissingAskViolation (ask-guard)', () => {
  it('flags a numbered option list with no ask_user call', () => {
    const reply = 'বস, দুটো পথ আছে:\n১. এখনই পোস্ট করি\n২. আগে ছবি বানাই\nকোনটা করব?'
    const v = detectMissingAskViolation(reply, ['get_product'])
    expect(v).toHaveLength(1)
    expect(v[0].category).toBe('missing_ask')
    expect(v[0].requiredTools).toEqual(['ask_user'])
  })

  it('flags a "করব, নাকি" A-or-B prose question', () => {
    const v = detectMissingAskViolation('ক্যাম্পেইনটা আজ চালাব, নাকি ঈদের পরে দেব?', [])
    expect(v).toHaveLength(1)
  })

  it('stays quiet when ask_user WAS called this turn', () => {
    const reply = 'বস, দুটো পথ আছে:\n১. এখনই পোস্ট\n২. আগে ছবি\nকোনটা করব?'
    expect(detectMissingAskViolation(reply, ['ask_user'])).toHaveLength(0)
  })

  it('never flags courtesy closers or plain answers', () => {
    expect(detectMissingAskViolation('কাজ শেষ বস। আর কী করতে পারি?', [])).toHaveLength(0)
    expect(detectMissingAskViolation('আজ বিক্রি ৳০, pending ২টা।', [])).toHaveLength(0)
    expect(detectMissingAskViolation('রিপোর্ট ready বস!', [])).toHaveLength(0)
  })
})
