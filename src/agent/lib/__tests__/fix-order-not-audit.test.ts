/**
 * Two live bugs, 2026-07-26, both caught by Boss watching a preview run.
 *
 * 1. He asked the agent to FIX the alt texts the audit had found. It produced
 *    ANOTHER audit report. "agent ke kaj dile fix korte, kintu abar SEO report
 *    baniye dilo." Cause: the audit contract armed on the mere WORDS "SEO" and
 *    "অডিট", with no regard for the verb.
 * 2. The turn then stopped after ~40 seconds claiming the SERVER ran out of
 *    time. It had not — the head had asked a question and quit. The message was
 *    printed for any answerless turn.
 */
import { describe, expect, it } from 'vitest'
import { deriveOwnerTurnRequirements } from '@/agent/lib/owner-turn-requirements'

describe('a fix order is not an audit order', () => {
  it('the exact message he sent asks for WORK, not a report', () => {
    const req = deriveOwnerTurnRequirements(
      'almatraders.com এর SEO অডিটে পাওয়া ছবির alt সমস্যা ঠিক করো — product_images.alt_text এ '
      + 'প্রতিটা ছবির জন্য বাংলা SEO-friendly alt লেখো।',
    )
    expect(req.clientSeo).toBe(false)
    expect(req.reportArtifact).toBe(false)
  })

  it.each([
    'almatraders.com এর SEO সমস্যাগুলো ঠিক করো',
    'audit এ পাওয়া issues গুলো fix করো almatraders.com এ',
    'almatraders.com এর প্রোডাক্ট পেজে meta description লিখে দাও',
  ])('still a work order: %s', (text) => {
    expect(deriveOwnerTurnRequirements(text).clientSeo).toBe(false)
  })

  it('a genuine audit request still arms the audit contract', () => {
    const req = deriveOwnerTurnRequirements('almatraders.com এর পূর্ণাঙ্গ SEO অডিট করো')
    expect(req.clientSeo).toBe(true)
    expect(req.reportArtifact).toBe(true)
  })

  it('deep-work scope is unaffected — a fix job is still deep work', () => {
    const req = deriveOwnerTurnRequirements(
      'almatraders.com এর সব SEO সমস্যা ঠিক করো, পুরোটা শেষ করো',
    )
    expect(req.clientSeo).toBe(false)
    expect(req.deepWork).toBe(true)
  })
})
