/**
 * OWNER INCIDENT 2026-07-26 — "tmi approve korecho but agent boltese je card
 * still approve hoy ni, she kono kaj kore ni."
 *
 * The approval had worked: the copy was live on 87 of 89 product pages, measured
 * independently. But the head kept replying "card অনুমোদনের অপেক্ষায় আছি" for work
 * it had already finished, because the continuation note only said an approval
 * happened — it never carried the FACTS. So the head trusted its own earlier
 * sentence over the world.
 *
 * The note now carries what changed and whether anything is genuinely still
 * pending. These are the shapes it must produce.
 */
import { describe, expect, it } from 'vitest'

/** Mirrors the builder in /api/assistant/actions/[id]/approve. */
function buildNote(input: {
  summary?: string
  result?: { applied?: unknown[]; failed?: unknown[] } | null
  stillPending: number
}): string {
  const summary = (input.summary ?? '').slice(0, 200)
  const applied = (() => {
    const r = input.result
    if (!r || !Array.isArray(r.applied)) return ''
    const failed = Array.isArray(r.failed) ? r.failed.length : 0
    return ` (${r.applied.length}টি প্রয়োগ হয়েছে${failed ? `, ${failed}টি ব্যর্থ` : ''})`
  })()
  return (
    '[সিস্টেম নোট — Boss approve করেছেন] একটা pending কাজ Boss approve করেছেন এবং সেটা সম্পন্ন হয়েছে'
    + (summary ? `: "${summary}"` : '') + applied
    + '। এখন থেমে যেও না — তোমার চলমান কাজের পরের ধাপে নিজে থেকে এগোও, অথবা সব শেষ হলে সংক্ষেপে Boss-কে জানাও। '
    + 'যে কাজটা এইমাত্র approve হয়ে সম্পন্ন হয়েছে সেটা আর নতুন করে কোরো না। '
    + (input.stillPending > 0
      ? `এই চ্যাটে আরও ${input.stillPending}টি card এখনো Boss-এর সিদ্ধান্তের অপেক্ষায় আছে।`
      : 'এই চ্যাটে আর কোনো card অপেক্ষায় নেই — তাই "অনুমোদনের অপেক্ষায় আছি" বোলো না; '
        + 'বাকি কাজ থাকলে নিজেই এগোও, না থাকলে গুনে ফল জানাও।')
  )
}

describe('the continuation note carries facts, not just "approved"', () => {
  it('says how many were actually applied', () => {
    const note = buildNote({ summary: 'Batch 4', result: { applied: [1, 2, 3, 4] }, stillPending: 0 })
    expect(note).toContain('4টি প্রয়োগ হয়েছে')
  })

  it('names failures rather than hiding them', () => {
    const note = buildNote({ result: { applied: [1, 2], failed: [3] }, stillPending: 0 })
    expect(note).toContain('2টি প্রয়োগ হয়েছে, 1টি ব্যর্থ')
  })

  // The exact sentence he had to correct twice.
  it('forbids "waiting for approval" when nothing is pending', () => {
    const note = buildNote({ result: { applied: [1] }, stillPending: 0 })
    expect(note).toContain('আর কোনো card অপেক্ষায় নেই')
    expect(note).toContain('"অনুমোদনের অপেক্ষায় আছি" বোলো না')
  })

  it('but says so plainly when a card really is still open', () => {
    const note = buildNote({ result: { applied: [1] }, stillPending: 2 })
    expect(note).toContain('আরও 2টি card')
    expect(note).not.toContain('আর কোনো card অপেক্ষায় নেই')
  })

  it('survives an action that recorded no structured result', () => {
    const note = buildNote({ summary: 'কিছু একটা', result: null, stillPending: 0 })
    expect(note).toContain('কিছু একটা')
    expect(note).not.toContain('প্রয়োগ হয়েছে')
  })

  it('always tells it not to redo the finished work', () => {
    expect(buildNote({ stillPending: 0 })).toContain('আর নতুন করে কোরো না')
  })
})
