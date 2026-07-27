/**
 * Owner, live 2026-07-27: he planned the job, tapped "হ্যাঁ, Panjabi আগে করে full
 * proceed করুন", and the very next turn asked him a near-identical question —
 * as a fresh card, because the prose-choice rule promoted it into one.
 *
 * The prose-choice rule is right when a question is genuinely needed. On a turn
 * that answers his card it is exactly wrong: it manufactures the drip of cards
 * he has been objecting to all week.
 */
import { describe, it, expect } from 'vitest'
import {
  detectRedundantQuestionAfterAnswer,
  detectProseChoiceViolation,
  buildVerificationReminder,
} from '@/agent/lib/claim-verifier'

/** The shape of the draft that got promoted into a second card, live. */
const REASKED = [
  'বস, product-code-13 এর page দেখলাম — সব ছবিতেই alt text আছে।',
  'আপনি কি চাইছেন:',
  '1. আরও ভালো/SEO-friendly alt text বসাতে?',
  '2. নাকি নির্দিষ্ট কিছু product আছে যেগুলোতে alt নেই?',
].join('\n')

describe('asking again right after he answered', () => {
  it('catches the re-ask', () => {
    expect(detectRedundantQuestionAfterAnswer(REASKED).length).toBe(1)
    expect(detectRedundantQuestionAfterAnswer(REASKED)[0].category).toBe('redundant_question')
  })

  it('tells it to WORK, not to make another card', () => {
    const reminder = buildVerificationReminder(detectRedundantQuestionAfterAnswer(REASKED))
    expect(reminder).toContain('এখনই কাজ শুরু করুন')
    expect(reminder).not.toContain('ask_user call')
  })

  it('the old rule would have demanded another card for the same text', () => {
    const old = detectProseChoiceViolation(REASKED)
    expect(old.length).toBe(1)
    expect(old[0].requiredTools).toContain('ask_user')
  })

  it('stays quiet on a plain progress report', () => {
    expect(detectRedundantQuestionAfterAnswer('১০টার মধ্যে ৯টায় title/meta দুর্বল — কপি লিখছি।')).toEqual([])
    expect(detectRedundantQuestionAfterAnswer('কাজ শেষ, ৮৭টা product আপডেট হয়েছে।')).toEqual([])
  })

  it('stays quiet on text too short to be a question', () => {
    expect(detectRedundantQuestionAfterAnswer('ঠিক আছে')).toEqual([])
  })
})
