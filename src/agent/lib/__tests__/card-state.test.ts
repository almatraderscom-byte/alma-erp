/**
 * Owner incident 2026-07-26 — the head asserted card state from memory: "কার্ড
 * অনুমোদনের অপেক্ষায় আছি" with no card in existence, and again for work already
 * applied. Every turn now carries the server's answer, and the claim is checked
 * against it.
 */
import { describe, it, expect } from 'vitest'
import { buildCardStateNote } from '@/agent/lib/card-state'
import { detectPhantomApprovalWait } from '@/agent/lib/claim-verifier'

describe('card-state note', () => {
  it('states plainly when nothing is pending, and forbids the phrase', () => {
    const note = buildCardStateNote([])
    expect(note).toContain('কোনো approval card নেই')
    expect(note).toContain('অনুমোদনের অপেক্ষায় আছি')
    expect(note).toContain('সার্ভার থেকে পড়া')
  })

  it('lists what is genuinely pending', () => {
    const note = buildCardStateNote([
      { id: 'a1', type: 'seo_fix_batch', summary: '🔍 SEO ফিক্স — ৫টি product' },
      { id: 'a2', type: 'staff_message', summary: 'Mustahid-কে বার্তা' },
    ])
    expect(note).toContain('2টি approval card')
    expect(note).toContain('seo_fix_batch')
    expect(note).toContain('staff_message')
  })

  it('keeps the summary to its first line', () => {
    const note = buildCardStateNote([{ id: 'a1', type: 'seo_fix_batch', summary: 'প্রথম লাইন\nদ্বিতীয় লাইন' }])
    expect(note).toContain('প্রথম লাইন')
    expect(note).not.toContain('দ্বিতীয় লাইন')
  })
})

describe('phantom approval wait', () => {
  const fires = (text: string, pending: number) => detectPhantomApprovalWait(text, pending).length > 0

  it('catches a wait claim when no card exists', () => {
    expect(fires('কার্ডটা এখনো অনুমোদনের অপেক্ষায় আছে।', 0)).toBe(true)
    expect(fires('বস, approval card-টা approve করুন।', 0)).toBe(true)
    expect(fires('Still waiting for your approval.', 0)).toBe(true)
  })

  it('stays quiet when a card really is pending', () => {
    expect(fires('কার্ডটা এখনো অনুমোদনের অপেক্ষায় আছে।', 1)).toBe(false)
    expect(fires('বস, approval card-টা approve করুন।', 2)).toBe(false)
  })

  it('does not fire on ordinary prose', () => {
    expect(fires('৮৭টা product-এর meta আপডেট হয়ে গেছে।', 0)).toBe(false)
    expect(fires('গতকাল আপনি কার্ডটা approve করেছিলেন।', 0)).toBe(false)
  })
})
