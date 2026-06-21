/**
 * Per-model cost guard.
 *
 * Bug this locks down: every Anthropic model used to be billed at Sonnet's fixed
 * $3/$15 rate, so Opus ($15/$75) and Haiku ($1/$5) head/worker turns were mis-costed
 * and the cost page could not show what each model actually cost. Each model must now
 * be priced at its OWN registry rate; Sonnet's number must stay unchanged.
 */
import { describe, it, expect } from 'vitest'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { getModel } from '@/agent/lib/models/registry'

const ONE_M = 1_000_000

describe('calcModelTurnCostUsd — bills each model at its own rate', () => {
  it('Sonnet input/output unchanged ($3 / $15 per Mtok)', () => {
    const cost = calcModelTurnCostUsd(getModel('claude-sonnet-4-6'), {
      inputTokens: ONE_M,
      outputTokens: ONE_M,
    })
    expect(cost).toBeCloseTo(18, 6) // 3 + 15
  })

  it('Opus is billed at Opus rate, NOT Sonnet ($15 / $75 per Mtok)', () => {
    const cost = calcModelTurnCostUsd(getModel('claude-opus-4-8'), {
      inputTokens: ONE_M,
      outputTokens: ONE_M,
    })
    expect(cost).toBeCloseTo(90, 6) // 15 + 75 — would have been 18 under the old bug
  })

  it('Haiku is billed at Haiku rate ($1 / $5 per Mtok)', () => {
    const cost = calcModelTurnCostUsd(getModel('claude-haiku-4-5'), {
      inputTokens: ONE_M,
      outputTokens: ONE_M,
    })
    expect(cost).toBeCloseTo(6, 6) // 1 + 5
  })

  it('Anthropic cache tokens derive from the model input rate (Sonnet: write 3.75, read 0.3)', () => {
    const cost = calcModelTurnCostUsd(getModel('claude-sonnet-4-6'), {
      inputTokens: 0,
      outputTokens: 0,
      cacheWrite: ONE_M,
      cacheRead: ONE_M,
    })
    expect(cost).toBeCloseTo(3.75 + 0.3, 6)
  })

  it('Opus cache tokens scale with Opus input rate (write 18.75, read 1.5)', () => {
    const cost = calcModelTurnCostUsd(getModel('claude-opus-4-8'), {
      inputTokens: 0,
      outputTokens: 0,
      cacheWrite: ONE_M,
      cacheRead: ONE_M,
    })
    expect(cost).toBeCloseTo(18.75 + 1.5, 6)
  })

  it('OpenRouter model uses its own rate (DeepSeek $0.09 / $0.18)', () => {
    const cost = calcModelTurnCostUsd(getModel('or-deepseek-v4-flash'), {
      inputTokens: ONE_M,
      outputTokens: ONE_M,
    })
    expect(cost).toBeCloseTo(0.27, 6) // 0.09 + 0.18
  })

  it('OpenRouter cached reads are re-added at the input rate (cost unchanged vs all-in prompt_tokens)', () => {
    const model = getModel('or-deepseek-v4-flash')
    // Adapter now splits prompt_tokens into uncached input + cacheRead. Pricing the
    // two separately must equal pricing the combined total at the input rate, so the
    // display fix doesn't move the billed number.
    const split = calcModelTurnCostUsd(model, {
      inputTokens: 0.4 * ONE_M,
      outputTokens: ONE_M,
      cacheRead: 0.6 * ONE_M,
    })
    const combined = calcModelTurnCostUsd(model, {
      inputTokens: ONE_M, // old behaviour: cached folded into input
      outputTokens: ONE_M,
    })
    expect(split).toBeCloseTo(combined, 6)
  })
})
