/**
 * "কী হচ্ছে এখন" — the status line during a silent stretch.
 *
 * Owner ask 2026-07-27: never leave him watching a spinner. I had remembered a
 * "progress every 3 rounds" rule already shipping; it did not exist. What these
 * lock is the CADENCE, because the two ways this feature fails are both about
 * timing: too quiet (he learns nothing) and too chatty (he learns to ignore it).
 */
import { describe, expect, it } from 'vitest'
import {
  newTurnProgressState,
  nextTurnProgress,
  PROGRESS_EVERY_ROUNDS,
  PROGRESS_MIN_GAP_MS,
} from '@/agent/lib/turn-progress'

const base = {
  spokeSinceLast: false,
  elapsedMs: 30_000,
  lastToolLabel: 'get_website_health',
  nowMs: 100_000,
}

describe('when it speaks', () => {
  it('stays quiet for the first couple of rounds', () => {
    const s = newTurnProgressState()
    expect(nextTurnProgress(s, { ...base, round: 1 })).toBeNull()
    expect(nextTurnProgress(s, { ...base, round: PROGRESS_EVERY_ROUNDS - 1 })).toBeNull()
  })

  it('speaks once the silent stretch is long enough', () => {
    const out = nextTurnProgress(newTurnProgressState(), { ...base, round: PROGRESS_EVERY_ROUNDS })
    expect(out).not.toBeNull()
    expect(out!.progress.text).toContain('৩ ধাপ শেষ')
    expect(out!.progress.text).toContain('get_website_health')
  })

  it('says the elapsed time in seconds, because "still working" without a number says nothing', () => {
    const out = nextTurnProgress(newTurnProgressState(), { ...base, round: 3, elapsedMs: 42_000 })
    expect(out!.progress.elapsedSec).toBe(42)
    expect(out!.progress.text).toContain('৪২s')
  })
})

describe('when it stays quiet — the half that keeps it useful', () => {
  it('says nothing while the model is narrating', () => {
    // A status line under a live stream of text is noise, and noise is how a
    // real signal gets ignored.
    expect(
      nextTurnProgress(newTurnProgressState(), { ...base, round: 9, spokeSinceLast: true }),
    ).toBeNull()
  })

  it('does not repeat itself on the very next round', () => {
    const first = nextTurnProgress(newTurnProgressState(), { ...base, round: 3 })!
    expect(
      nextTurnProgress(first.state, { ...base, round: 4, nowMs: base.nowMs + 1_000 }),
    ).toBeNull()
  })

  it('holds the minimum gap even when rounds fly past', () => {
    const first = nextTurnProgress(newTurnProgressState(), { ...base, round: 3 })!
    // Three more rounds, but only a second later — a fast tool burst must not
    // turn into three status lines.
    expect(
      nextTurnProgress(first.state, { ...base, round: 6, nowMs: base.nowMs + 1_000 }),
    ).toBeNull()
    expect(
      nextTurnProgress(first.state, { ...base, round: 6, nowMs: base.nowMs + PROGRESS_MIN_GAP_MS + 1 }),
    ).not.toBeNull()
  })
})

describe('shape', () => {
  it('drops the "এখন …" clause rather than printing an empty one', () => {
    const out = nextTurnProgress(newTurnProgressState(), { ...base, round: 3, lastToolLabel: null })
    expect(out!.progress.text).not.toContain('এখন')
    expect(out!.progress.text).toContain('ধাপ শেষ')
  })
})
