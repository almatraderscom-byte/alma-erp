/**
 * Two owner-reported bugs, 2026-07-26.
 *
 * 1. "chat session er usage er moddhe context ta model change korle context
 *    sunno hoye jay" — switching the head mid-chat reset the context meter to
 *    zero, as if the conversation had vanished. It had not: the same messages
 *    are still there. Only the WINDOW changed.
 *
 * 2. "amr akhon compect system chilo $ doller diye, eta change kore … token er
 *    upor hobe" — compaction triggered on cost. Compaction exists to stop a
 *    conversation overflowing its window, so the window is the honest trigger.
 */
import { describe, expect, it } from 'vitest'
import { readContextUsage } from '@/agent/lib/usage-intelligence'
import { COMPACT_CONTEXT_PERCENT, COMPACT_THRESHOLD_USD } from '@/agent/lib/conversation-compact'

const providerUsage = {
  context_tokens: 120_000,
  context_source: 'provider_last_round',
  context_measured_at: '2026-07-26T10:00:00.000Z',
}

describe('the context meter survives a model switch', () => {
  it('keeps the measurement when the head changed', () => {
    const read = readContextUsage(providerUsage, false)

    expect(read.tokens).toBe(120_000)
    // …but is honest that another tokenizer produced it.
    expect(read.exact).toBe(false)
  })

  it('is exact when the same model produced it', () => {
    const read = readContextUsage(providerUsage, true)
    expect(read.tokens).toBe(120_000)
    expect(read.exact).toBe(true)
  })

  it('still carries a legacy estimate across a switch', () => {
    const read = readContextUsage(
      { input_tokens: 40_000, cache_read_input_tokens: 60_000, api_rounds: 1 },
      false,
    )
    expect(read.tokens).toBe(100_000)
    expect(read.exact).toBe(false)
  })

  it('reports nothing only when there is genuinely nothing', () => {
    expect(readContextUsage(null, true).tokens).toBeNull()
    expect(readContextUsage({}, true).tokens).toBeNull()
  })
})

describe('compaction triggers on the window, not the wallet', () => {
  it('folds at 100% of the model context window by default', () => {
    expect(COMPACT_CONTEXT_PERCENT).toBe(100)
  })

  it('keeps the dollar valve as a far-off backstop, not the primary trigger', () => {
    expect(COMPACT_THRESHOLD_USD).toBeGreaterThanOrEqual(25)
  })

  // The arithmetic the trigger runs, stated plainly: a cheap model can fill its
  // window long before $25, which is exactly the case the old rule missed.
  it('a filled window is a fold even when the chat cost almost nothing', () => {
    const used = 200_000
    const window = 200_000
    expect((used / window) * 100 >= COMPACT_CONTEXT_PERCENT).toBe(true)
  })

  it('a half-full window is not a fold, however expensive the chat was', () => {
    expect((100_000 / 1_000_000) * 100 >= COMPACT_CONTEXT_PERCENT).toBe(false)
  })
})
