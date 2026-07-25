/**
 * Cost audit Phase 8 — cache accounting must follow the ACTUAL head model.
 *
 * Two bugs this locks down:
 *  1. `computePromptCacheSavings` priced every cached token at Sonnet's
 *     $3/Mtok input rate. The production head is Grok ($1.25), so once the
 *     underlying query widened past `provider = 'anthropic'` the saving would
 *     have been overstated ~2.4x for the model serving most traffic.
 *  2. The generic non-Anthropic cache multiplier (0.25x) guessed $0.3125/Mtok
 *     for Grok cached input, while xAI publishes $0.20 — a 56% over-statement.
 */
import { describe, it, expect } from 'vitest'
import { computePromptCacheSavings } from '@/agent/lib/cost-dashboard'
import { cacheReadRatePerM, calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { getModel } from '@/agent/lib/models/registry'

const ONE_M = 1_000_000

describe('cacheReadRatePerM — published rate wins over the multiplier estimate', () => {
  it('Grok uses xAI\'s published $0.20, not the 0.25x guess ($0.3125)', () => {
    expect(cacheReadRatePerM(getModel('xai-grok-4.20'))).toBeCloseTo(0.2, 6)
  })

  it('models without a published rate keep the old multiplier estimate', () => {
    const sonnet = getModel('claude-sonnet-4-6')
    // Anthropic cache read = 0.1x input, unchanged.
    expect(cacheReadRatePerM(sonnet)).toBeCloseTo(sonnet.inPerM * 0.1, 6)
  })

  it('billing uses the published rate for Grok cached reads', () => {
    const cost = calcModelTurnCostUsd(getModel('xai-grok-4.20'), {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: ONE_M,
    })
    expect(cost).toBeCloseTo(0.2, 6) // was 0.3125 before Phase 8
  })
})

describe('computePromptCacheSavings — priced per model, not per Sonnet', () => {
  it('prices Grok cached tokens at Grok rates', () => {
    const { usdSaved, tokensSaved } = computePromptCacheSavings({
      cacheReadTokens: ONE_M,
      cacheCreationTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      chatTurns: 1,
      byModel: [{ modelId: 'xai-grok-4.20', cacheReadTokens: ONE_M, inputTokens: 0 }],
    })
    expect(tokensSaved).toBe(ONE_M)
    // saved = full input ($1.25) − cached ($0.20) = $1.05, NOT Sonnet's $2.70
    expect(usdSaved).toBeCloseTo(1.05, 4)
  })

  it('sums a mixed-provider day at each model\'s own rate', () => {
    const sonnet = getModel('claude-sonnet-4-6')
    const { usdSaved } = computePromptCacheSavings({
      cacheReadTokens: 2 * ONE_M,
      cacheCreationTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      chatTurns: 2,
      byModel: [
        { modelId: 'xai-grok-4.20', cacheReadTokens: ONE_M, inputTokens: 0 },
        { modelId: 'claude-sonnet-4-6', cacheReadTokens: ONE_M, inputTokens: 0 },
      ],
    })
    const expected = 1.05 + (sonnet.inPerM - sonnet.inPerM * 0.1)
    expect(usdSaved).toBeCloseTo(expected, 4)
  })

  it('an unknown model contributes 0 instead of a guessed rate', () => {
    const { usdSaved } = computePromptCacheSavings({
      cacheReadTokens: ONE_M,
      cacheCreationTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      chatTurns: 1,
      byModel: [{ modelId: 'some-model-we-do-not-know', cacheReadTokens: ONE_M, inputTokens: 0 }],
    })
    expect(usdSaved).toBe(0)
  })
})
