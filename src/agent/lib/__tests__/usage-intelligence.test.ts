import { describe, expect, it } from 'vitest'
import { buildContextBreakdown, readContextUsage } from '@/agent/lib/usage-intelligence'

describe('usage intelligence context telemetry', () => {
  it('uses the provider last-round context instead of cumulative billed input', () => {
    const reading = readContextUsage({
      input_tokens: 320_000,
      cache_read_input_tokens: 260_000,
      context_tokens: 91_250,
      context_source: 'provider_last_round',
      context_measured_at: '2026-07-25T10:00:00.000Z',
      api_rounds: 6,
    }, true)

    expect(reading).toEqual({
      tokens: 91_250,
      source: 'provider_last_round',
      measuredAt: '2026-07-25T10:00:00.000Z',
      exact: true,
    })
  })

  it('marks old multi-round cumulative telemetry as an estimate', () => {
    expect(readContextUsage({
      input_tokens: 120_000,
      cache_read_input_tokens: 80_000,
      api_rounds: 4,
    }, true)).toMatchObject({
      tokens: 200_000,
      source: 'legacy_estimate',
      exact: false,
    })
  })

  // REVERSED by owner report, 2026-07-26: "model change korle context sunno hoye
  // jay". The old rule threw the measurement away and showed zero until the new
  // head produced its own. But the conversation did not shrink — the same
  // messages are still there; only the window changed. Showing 0 of 200k for a
  // chat that plainly holds 50k is worse than showing a number from another
  // tokenizer, so the measurement carries over and is marked inexact.
  it('keeps the measurement across a model change, flagged as inexact', () => {
    expect(readContextUsage({
      context_tokens: 50_000,
      context_source: 'provider_last_round',
    }, false)).toEqual({
      tokens: 50_000,
      source: 'provider_last_round',
      measuredAt: null,
      exact: false,
    })
  })

  it('reconciles estimated categories to the provider total and keeps free space exact', () => {
    const rows = buildContextBreakdown({
      usedTokens: 350_000,
      contextWindow: 1_000_000,
      messageTokens: 300_000,
      systemTokens: 80_000,
      toolTokens: 60_000,
      memoryTokens: 10_000,
    })
    const usedRows = rows.filter((row) => row.id !== 'free')
    const free = rows.find((row) => row.id === 'free')

    expect(usedRows.reduce((sum, row) => sum + row.tokens, 0)).toBe(350_000)
    expect(free?.tokens).toBe(650_000)
    expect(free?.percentage).toBe(65)
  })
})
