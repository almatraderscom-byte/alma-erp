/**
 * The spoken first line must never be mistaken for WORK OUTPUT.
 *
 * Owner hit this live on the preview 2026-07-25 with "hea amk ektu best idea daw
 * creative te dekhe": the preamble was spoken, the model's next round returned
 * only reasoning (no text, no tool call), and the turn ENDED there — the first
 * line became the entire reply. Cause: the empty-round guard asked
 * `!finalText.trim()`, and seeding the preamble into finalText had blinded it.
 *
 * `answerBody()` in run-owner-turn is finalText minus that first line. This
 * suite pins its semantics, because three separate guards depend on it:
 * the empty-round retry, the empty-turn throw (cheap-head fallback), and the
 * deadline salvage.
 */
import { describe, it, expect } from 'vitest'

/** Mirror of the helper in run-owner-turn (kept in lockstep by this suite). */
function answerBody(finalText: string, preambleText: string): string {
  const t = finalText.trim()
  const p = preambleText.trim()
  if (!p) return t
  return t.startsWith(p) ? t.slice(p.length).trim() : t
}

const PREAMBLE = 'বস, creative-এ best idea চাইছেন দেখে — Eyafi ও Mustahid-এর চলমান creative tasks চেক করছি।'

describe('answerBody — "did this turn produce work output?"', () => {
  it('a turn holding ONLY the spoken first line has produced nothing', () => {
    expect(answerBody(PREAMBLE, PREAMBLE)).toBe('')
  })

  it('the first line plus a real answer counts as output', () => {
    const answer = 'সেরা আইডিয়া: family-set creative, CTR 10.85% ওয়ালা angle-টা scale করুন।'
    expect(answerBody(`${PREAMBLE}\n\n${answer}`, PREAMBLE)).toBe(answer)
  })

  it('is a plain trim when no preamble was spoken (greeting / continuation turns)', () => {
    expect(answerBody('  আজ ৫টা অর্ডার পেন্ডিং।  ', '')).toBe('আজ ৫টা অর্ডার পেন্ডিং।')
    expect(answerBody('', '')).toBe('')
  })

  it('leaves the text alone when a retry replaced the draft and the prefix is gone', () => {
    const rewritten = 'বস, যাচাই করে দেখলাম — সংখ্যাটা ভিন্ন।'
    expect(answerBody(rewritten, PREAMBLE)).toBe(rewritten)
  })

  it('does not treat a preamble-like OPENING of the real answer as empty', () => {
    // The answer may legitimately start with the same "বস," address without
    // being the preamble itself.
    const answer = 'বস, ৪টা ক্যাম্পেইনই HOLD — thin data।'
    expect(answerBody(answer, PREAMBLE)).toBe(answer)
  })

  it('whitespace-only remainder still counts as no output', () => {
    expect(answerBody(`${PREAMBLE}   \n\n  `, PREAMBLE)).toBe('')
  })
})

describe('the guards that depend on it', () => {
  const emptyRoundRetryFires = (finalText: string, preamble: string, iterationText: string) =>
    !iterationText.trim() && !answerBody(finalText, preamble)

  it('fires on the exact live incident: preamble spoken, round returned only reasoning', () => {
    expect(emptyRoundRetryFires(PREAMBLE, PREAMBLE, '')).toBe(true)
  })

  it('stays quiet once the model has written a real answer', () => {
    expect(emptyRoundRetryFires(`${PREAMBLE}\n\nউত্তর: ৫টা।`, PREAMBLE, '')).toBe(false)
  })

  const emptyTurnThrows = (finalText: string, preamble: string, tools: number, cards: number) =>
    !answerBody(finalText, preamble) && tools === 0 && cards === 0

  it('the empty-turn safety net still catches a turn that only spoke its first line', () => {
    expect(emptyTurnThrows(PREAMBLE, PREAMBLE, 0, 0)).toBe(true)
    // …but not one that actually ran a tool.
    expect(emptyTurnThrows(PREAMBLE, PREAMBLE, 1, 0)).toBe(false)
  })
})
