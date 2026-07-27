/**
 * What the agent does when Boss says it got something wrong.
 *
 * Asked for by name on 2026-07-27. The detector is the risky half: a false
 * positive makes the agent apologise for a compliment, which is its own kind of
 * insulting. So the cases below are his ACTUAL words — from this conversation and
 * from the handoff — not invented complaints.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildOwnerCorrectionNudge,
  looksLikeOwnerCorrection,
} from '@/agent/lib/owner-correction'

afterEach(() => vi.unstubAllEnvs())

describe('recognising a correction', () => {
  it('catches the message that produced this feature, in his own words', () => {
    expect(
      looksLikeOwnerCorrection(
        'bhai tmi 3 number jaccho bole theme aso keno? r tmi agent somossa ta nije age jacai na kore tmi o belive korle. why? is it a professional way to develop?',
      ),
    ).toBe(true)
  })

  it('catches Bangla script, Banglish and English alike', () => {
    for (const t of [
      'এটা তো ভুল হয়েছে',
      'tumi bolle korbe kintu koro nai',
      'this number is wrong',
      'jacai na kore kivabe bolle?',
      'reply ta bodle gelo keno',
      'amar rag lagche',
    ]) {
      expect(looksLikeOwnerCorrection(t), t).toBe(true)
    }
  })
})

describe('NOT firing — a false positive apologises for a compliment', () => {
  it('stays quiet on praise, even when it mentions a past mistake being fixed', () => {
    for (const t of [
      'thanks bhai',
      'valo hoyeche, egiye jao',
      'perfect, ekhon merge koro',
      'ok',
      'ha koro',
    ]) {
      expect(looksLikeOwnerCorrection(t), t).toBe(false)
    }
  })

  it('ignores a message too short to carry a complaint', () => {
    expect(looksLikeOwnerCorrection('keno')).toBe(false)
  })
})

describe('the block itself', () => {
  const nudge = () =>
    buildOwnerCorrectionNudge('tumi jacai na kore bolle keno? eta ki professional?') ?? ''

  it('tells him to concede FIRST, before any explanation', () => {
    const text = nudge()
    const concede = text.indexOf('মেনে নাও')
    const verify = text.indexOf('যাচাই করো')
    expect(concede).toBeGreaterThan(-1)
    // Order is the whole point: a model that explains before admitting reads as
    // defending itself, which is what made him angry in the first place.
    expect(concede).toBeLessThan(verify)
  })

  it('asks it to RANK the complaints itself — the part he singled out', () => {
    expect(nudge()).toContain('কোনটা বেশি গুরুতর')
  })

  it('forbids a fresh unbacked claim while conceding', () => {
    expect(nudge()).toContain('নতুন কোনো দাবি করো না')
  })

  it('caps the apology instead of only banning repetition', () => {
    expect(nudge()).toContain('একবারই দুঃখিত')
  })

  it('is silent when the flag is off', () => {
    vi.stubEnv('AGENT_OWNER_CORRECTION', 'false')
    expect(buildOwnerCorrectionNudge('tumi bhul korecho keno?')).toBeNull()
  })

  it('handles the case where HE misread, without telling him he misread', () => {
    // 2026-07-27, live: he read a table cell as "artifact reports are wrong"
    // when it said the opposite. Answering "you misunderstood" is a fight;
    // owning the wording and quoting the real text is not.
    const text = buildOwnerCorrectionNudge('tumi eta keno bhul bolle? ami to report na banale client ke pathabo kivabe?') ?? ''
    expect(text).toContain('উল্টো বুঝে')
    expect(text).toContain('দোষটা')
    expect(text).toContain('হুবহু তুলে দাও')
  })

  it('is silent on a message that is not a correction', () => {
    expect(buildOwnerCorrectionNudge('ajker sale koto?')).toBeNull()
  })
})
