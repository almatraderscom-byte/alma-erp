/**
 * OWNER OBSERVATION 2026-07-27 — a reply opened with the same sentence twice.
 * The two lines are the real ones from his screen; note they are NOT identical,
 * which is why seeding the transcript and any equality check both missed it.
 */
import { describe, expect, it } from 'vitest'
import { isRepeatedOpener } from '@/agent/lib/turn-loop-policy'

const OPENER = 'বস, আপনি এখন কোনো SEO fix কাজ করার দরকার নেই বলেছেন — চলমান seo task-এর স্ট্যাটাস যাচাই করছি।'

describe('a restated opening line is caught, a real progress line is not', () => {
  it('catches the exact pair he saw', () => {
    const restated = 'বস, আপনি এখন কোনো SEO fix কাজ করার দরকার নেই বলেছেন — seo task-এর চলমান স্ট্যাটাস যাচাই করছি।'
    expect(isRepeatedOpener(OPENER, restated)).toBe(true)
  })

  it('catches a verbatim repeat too', () => {
    expect(isRepeatedOpener(OPENER, OPENER)).toBe(true)
  })

  it('leaves a genuine progress update alone', () => {
    const progress = 'catalogue পড়া শেষ — ৫০টা product-এর মধ্যে ৪২টায় সমস্যা, এখন প্রথম ১০টার draft বানাচ্ছি।'
    expect(isRepeatedOpener(OPENER, progress)).toBe(false)
  })

  it('leaves a longer answer that reuses some words alone', () => {
    const answer =
      'বস, seo task-এর স্ট্যাটাস দেখলাম: ৫০টা product scan হয়েছে, ২টায় slug problem, '
      + 'meta description সব ঠিক আছে। slug দুটো ঠিক করতে হলে 301 redirect লাগবে, '
      + 'কারণ URL বদলে যাবে — সেটা আপনার সিদ্ধান্ত।'
    expect(isRepeatedOpener(OPENER, answer)).toBe(false)
  })

  it('never fires on short text — too little to judge', () => {
    expect(isRepeatedOpener(OPENER, 'ঠিক আছে')).toBe(false)
    expect(isRepeatedOpener('হ্যাঁ', 'হ্যাঁ')).toBe(false)
  })

  it('two unrelated sentences are not a repeat', () => {
    expect(isRepeatedOpener(OPENER, 'বস, আজকের বিক্রি ১২,৫০০ টাকা — গতকালের চেয়ে ৮% বেশি।')).toBe(false)
  })
})
