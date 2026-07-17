import { describe, it, expect } from 'vitest'
import { resolveBanglaTimeExpression, buildReminderTimeHintBlock } from '@/agent/lib/bangla-time'

// Fixed "now": 2026-07-17 10:00 Dhaka (04:00 UTC) — a Friday morning.
const NOW = new Date('2026-07-17T04:00:00.000Z')

function iso(text: string, now = NOW): string | null {
  return resolveBanglaTimeExpression(text, now)?.iso ?? null
}

describe('resolveBanglaTimeExpression — the owner’s real voice phrasings', () => {
  it('"amake 4 tay call dio" → next 4 o’clock = 16:00 today (rc-0171 sister case)', () => {
    expect(iso('amake 4 tay call dio')).toBe('2026-07-17T16:00:00+06:00')
  })

  it('"আমাকে ৪টায় কল দিও" (Bangla numerals) → 16:00 today', () => {
    expect(iso('আমাকে ৪টায় কল দিও')).toBe('2026-07-17T16:00:00+06:00')
  })

  it('daypart words pin am/pm: বিকাল/সকাল/রাত', () => {
    expect(iso('বিকাল ৪টায় মনে করিয়ে দিও')).toBe('2026-07-17T16:00:00+06:00')
    expect(iso('kal shokal 9 tay remind koro')).toBe('2026-07-18T09:00:00+06:00')
    expect(iso('রাত ১০টায় ফোন দিও')).toBe('2026-07-17T22:00:00+06:00')
    expect(iso('দুপুর ২টার সময় মনে করাবে')).toBe('2026-07-17T14:00:00+06:00')
  })

  it('past clock position rolls to the NEXT occurrence', () => {
    // now = 10:00; "৯টায়" morning slot already gone → 21:00 today.
    expect(iso('৯টায় মনে করিয়ে দিও')).toBe('2026-07-17T21:00:00+06:00')
    // "সকাল ৯টায়" explicitly morning → tomorrow morning.
    expect(iso('সকাল ৯টায় মনে করিয়ে দিও')).toBe('2026-07-18T09:00:00+06:00')
  })

  it('সাড়ে / সোয়া / পৌনে half-hours', () => {
    expect(iso('সাড়ে ৪টায় কল দিও')).toBe('2026-07-17T16:30:00+06:00')
    expect(iso('soa 5 tay remind dio')).toBe('2026-07-17T17:15:00+06:00')
    expect(iso('পৌনে ৫টায় মনে করিয়ে দিও')).toBe('2026-07-17T16:45:00+06:00')
  })

  it('relative: minutes/hours থেকে এখন', () => {
    expect(iso('৩০ মিনিট পর মনে করিয়ে দিও')).toBe('2026-07-17T10:30:00+06:00')
    expect(iso('15 minute por amake call dio')).toBe('2026-07-17T10:15:00+06:00')
    expect(iso('ek ghonta pore remind koro')).toBe('2026-07-17T11:00:00+06:00')
    expect(iso('আধা ঘণ্টা বাদে কল দিও')).toBe('2026-07-17T10:30:00+06:00')
  })

  it('day words: কাল / পরশু / আগামীকাল', () => {
    expect(iso('কাল বিকাল ৫টায় মনে করিয়ে দিও')).toBe('2026-07-18T17:00:00+06:00')
    expect(iso('porshu dupur 12 tay remind dio')).toBe('2026-07-19T12:00:00+06:00')
    // no daypart + tomorrow: 1-6 reads as afternoon
    expect(iso('kal 4 tay call dio')).toBe('2026-07-18T16:00:00+06:00')
  })

  it('am/pm and 24h forms', () => {
    expect(iso('remind me at 7 pm')).toBe('2026-07-17T19:00:00+06:00')
    expect(iso('১৬:৩০ টায় মনে করিয়ে দিও')).toBe('2026-07-17T16:30:00+06:00')
  })

  it('word hours: চারটায় / char tay', () => {
    expect(iso('চারটায় কল দিও')).toBe('2026-07-17T16:00:00+06:00')
    expect(iso('char tay amake phone dio')).toBe('2026-07-17T16:00:00+06:00')
  })
})

describe('precision — must NOT read counting/quantities as times', () => {
  it('"৪টা অর্ডার" (4 orders) is not a clock time', () => {
    expect(iso('আজকে ৪টা অর্ডার এসেছে')).toBeNull()
  })
  it('"5 ta product ano" is not a clock time', () => {
    expect(iso('5 ta product list koro')).toBeNull()
  })
  it('bare quantities and money are ignored', () => {
    expect(iso('৫০০ টাকা খরচ লিখো')).toBeNull()
    expect(iso('stock koto ache?')).toBeNull()
    expect(iso('231 bestseller 40 pcs')).toBeNull()
  })
  it('"বিকালে ৪টা প্রোডাক্ট" — daypart present but ৪টা is still a count → time only via টায়/টার', () => {
    // Daypart makes bare টা acceptable — this is the accepted trade-off; the
    // reminder-intent gate in core.ts keeps it from firing on product chat.
    expect(iso('বিকাল ৪টায় দোকানে যেতে মনে করিয়ে দিও')).toBe('2026-07-17T16:00:00+06:00')
  })
  it('empty / no time → null', () => {
    expect(iso('amake call dio')).toBeNull()
    expect(iso('')).toBeNull()
  })
})

describe('buildReminderTimeHintBlock — the shared head directive', () => {
  it('produces a set_reminder directive with the exact ISO for "amake 4 tay call dio"', () => {
    const block = buildReminderTimeHintBlock('amake 4 tay call dio', NOW)
    expect(block).toContain('set_reminder')
    expect(block).toContain('2026-07-17T16:00:00+06:00')
    expect(block).toContain('tier 3')
  })
  it('null when not reminder-shaped or no time', () => {
    expect(buildReminderTimeHintBlock('stock koto ache?', NOW)).toBeNull()
    expect(buildReminderTimeHintBlock('amake call dio', NOW)).toBeNull()
    expect(buildReminderTimeHintBlock('আজকে ৪টা অর্ডার এসেছে', NOW)).toBeNull()
  })
})
