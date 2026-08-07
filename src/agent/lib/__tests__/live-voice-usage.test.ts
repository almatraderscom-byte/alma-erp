import { afterEach, describe, expect, it } from 'vitest'
import { priceLiveUsage } from '@/agent/lib/live-voice-usage'

const ENV_KEYS = [
  'LIVE_VOICE_AUDIO_IN_PER_M',
  'LIVE_VOICE_AUDIO_OUT_PER_M',
  'LIVE_VOICE_TOKENS_PER_AUDIO_SEC',
  'LIVE_VOICE_USD_PER_MIN',
] as const

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('priceLiveUsage — the overnight-session regression', () => {
  it('charges a silent session almost nothing, however long it stayed open', () => {
    // The 2026-08-07 incident: 19,637 wall seconds (5h 27m) with the phone on a
    // bed. The noise gate uplinked nothing, so nothing should be billed for it.
    const priced = priceLiveUsage({
      sessionId: 'sess-overnight',
      seq: 7,
      final: true,
      audioInSeconds: 0,
      audioOutSeconds: 0,
      seconds: 19_637,
    })
    // Nothing measured and nothing priceable — the row is refused outright.
    expect(priced).toBeNull()
  })

  it('never falls back to wall clock for a client reporting measured deltas', () => {
    // Guards against double-billing: the partial rows already priced the audio,
    // so a final report with no new audio must not re-price the whole call.
    expect(priceLiveUsage({ sessionId: 'sess-1', seconds: 3600 })).toBeNull()
    // Same payload without a session is a legacy build, which still reports.
    const legacy = priceLiveUsage({ seconds: 3600 })
    expect(legacy?.method).toBe('wall-clock')
  })

  it('prices measured audio at the published Live API rates', () => {
    // 60s uplink + 30s downlink at 25 tok/s → 1500 in, 750 out.
    // 1500 × $3/1M + 750 × $12/1M = 0.0045 + 0.009 = $0.0135
    const priced = priceLiveUsage({
      sessionId: 's', seq: 0, audioInSeconds: 60, audioOutSeconds: 30, seconds: 120,
    })
    expect(priced?.method).toBe('audio')
    expect(priced?.inputTokens).toBe(1500)
    expect(priced?.outputTokens).toBe(750)
    expect(priced?.costUsd).toBeCloseTo(0.0135, 6)
  })

  it('prefers provider token counts over derived audio when both are present', () => {
    const priced = priceLiveUsage({
      sessionId: 's', inputTokens: 1000, outputTokens: 100,
      audioInSeconds: 600, audioOutSeconds: 600,
    })
    expect(priced?.method).toBe('tokens')
    // 1000 × $3/1M + 100 × $12/1M = 0.003 + 0.0012
    expect(priced?.costUsd).toBeCloseTo(0.0042, 6)
  })

  it('honours env rate overrides so pricing can be corrected without a redeploy', () => {
    process.env.LIVE_VOICE_AUDIO_IN_PER_M = '6'
    process.env.LIVE_VOICE_AUDIO_OUT_PER_M = '24'
    const priced = priceLiveUsage({ sessionId: 's', audioInSeconds: 60, audioOutSeconds: 30 })
    expect(priced?.costUsd).toBeCloseTo(0.027, 6)   // exactly double the default
  })

  it('rejects junk instead of writing a garbage row', () => {
    expect(priceLiveUsage({})).toBeNull()
    expect(priceLiveUsage({ seconds: 0 })).toBeNull()
    expect(priceLiveUsage({ seconds: -5 })).toBeNull()
    expect(priceLiveUsage({ audioInSeconds: Number.NaN })).toBeNull()
    // Non-finite input is refused outright rather than priced as zero.
    expect(priceLiveUsage({ audioInSeconds: Infinity, sessionId: 's' })).toBeNull()
  })

  it('clamps an absurd but finite report instead of trusting it', () => {
    // A bad client claiming 1e9 seconds is held to the 12h ceiling.
    const priced = priceLiveUsage({ sessionId: 's', audioInSeconds: 1e9 })
    expect(priced?.method).toBe('audio')
    expect(priced?.costUsd).toBeCloseTo(12 * 3600 * 25 * (3 / 1_000_000), 6)
  })

  it('caps a wall-clock report at 12 hours', () => {
    const priced = priceLiveUsage({ seconds: 99 * 3600 })
    expect(priced?.method).toBe('wall-clock')
    expect(priced?.costUsd).toBeCloseTo((12 * 3600 / 60) * 0.015, 6)
  })

  it('costs a real 10-minute conversation cents, not dollars', () => {
    // 10 min of listening, 4 min of the model speaking.
    const priced = priceLiveUsage({
      sessionId: 's', audioInSeconds: 600, audioOutSeconds: 240, seconds: 600,
    })
    expect(priced!.costUsd).toBeGreaterThan(0.01)
    expect(priced!.costUsd).toBeLessThan(0.15)
  })
})
