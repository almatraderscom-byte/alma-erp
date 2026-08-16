/**
 * Script parity for the authorization gate (owner incident 2026-08-15).
 *
 * `BANGLISH_IMPERATIVE_RE` already granted dekhao/dekhaw/dekho; the Bangla
 * spellings were missing, so the same request got opposite permission depending
 * on which keyboard the owner used. Every pair below is the same sentence twice.
 */
import { describe, it, expect } from 'vitest'
import { deriveOwnerTurnAuthorization } from '../turn-authorization'

const allows = (t: string) => deriveOwnerTurnAuthorization(t).allowMutations

describe('Bangla and Banglish imperatives agree', () => {
  const pairs: Array<[string, string]> = [
    ['Mac live dekhaw', 'ম্যাক লাইভ দেখাও'],
    ['camera dekhao', 'ক্যামেরা দেখাও'],
    ['message pathaw', 'মেসেজ পাঠাও'],
    ['browser kholo', 'ব্রাউজার খোলো'],
    ['report banao', 'রিপোর্ট বানাও'],
  ]
  for (const [banglish, bangla] of pairs) {
    it(`"${bangla}" is an order, exactly like "${banglish}"`, () => {
      expect(allows(banglish), banglish).toBe(true)
      expect(allows(bangla), bangla).toBe(true)
    })
  }

  it('unblocks the exact message that failed for a whole session', () => {
    expect(allows('ম্যাক্সস্ট্রিমে ওখানে লাইভ দেখাও আমাকে।')).toBe(true)
    expect(allows('স্ক্রিনশট নাও')).toBe(true)
  })
})

describe('what must still NOT be an order', () => {
  it('an explicit no-action instruction still wins', () => {
    // EXPLICIT_NO_ACTION_RE is checked first, so it survives the new branch.
    expect(allows('শুধু বলো, কিছু কোরো না')).toBe(false)
  })

  it('a bare statement with no imperative stays information-only', () => {
    expect(allows('আজকে অফিসের অবস্থা ভালো ছিল')).toBe(false)
    expect(allows('গত মাসের বিক্রি কেমন ছিল')).toBe(false)
  })

  it('does not fire on inflected non-imperatives that merely contain the stem', () => {
    // The reason bare করে / দেখা are excluded: no \b for Bengali in JS regex, so
    // a bare stem would turn "it is not showing me" into an order.
    expect(allows('এটা আমাকে দেখাচ্ছে না')).toBe(false)
    expect(allows('আমি কাজটা করছি')).toBe(false)
  })

  // Codex P1: an unbounded alternation substring-matches inside ordinary words,
  // and this branch runs BEFORE the question guard — so these plain questions
  // would have shipped every write-class tool.
  it('does not read an imperative out of the middle of an ordinary word', () => {
    for (const msg of [
      'প্রতিদিন বিক্রি কেমন?',   // দিন
      'সেদিন কী হয়েছিল?',        // দিন
      'শেষ লেনদেন কত ছিল?',      // দেন
      'গত ৭ দিনের অর্ডার কত?',   // দিন
      'করোনার সময় কী হয়েছিল?',  // করো
      'আমাকে জানাও নি কেন?',     // নাও — inside জানাও
    ]) {
      expect(allows(msg), msg).toBe(false)
    }
  })

  // Codex P1 (second round): in Bengali the familiar 2nd-person present and the
  // imperative are the SAME form, so a token boundary cannot separate them —
  // only the question shape can.
  it('does not read a question as an order when the verb form is shared with the present tense', () => {
    for (const msg of [
      'তুমি প্রতিদিন কী করো?',      // করো = "do you do", not "do it"
      'তুমি কেন ওকে থামাও?',        // থামাও = "do you stop"
      'তুমি আমাকে কী দেখাও?',       // দেখাও = "do you show"
      'ওরা কেমন কাজ করো বলে মনে হয়?',
    ]) {
      expect(allows(msg), msg).toBe(false)
    }
  })

  it('still lets a plain order through — the guard is the question, not the verb', () => {
    // The two messages verified live on the preview carry no question marker.
    expect(allows('ম্যাক্সস্ট্রিমে ওখানে লাইভ দেখাও আমাকে।')).toBe(true)
    expect(allows('ক্যামেরা দেখাও')).toBe(true)
  })

  it('leaves out forms a boundary cannot disambiguate from nouns', () => {
    // বানান = spelling, চালান = invoice, খোল = husk. Excluded rather than
    // tokenised: no boundary can tell these from the imperative.
    expect(allows('এই শব্দের বানান কী?')).toBe(false)
    expect(allows('চালান নম্বর কত?')).toBe(false)
  })
})
