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

  it('DeepSeek cached reads are billed at the 0.1x provider discount, not full input rate', () => {
    const model = getModel('or-deepseek-v4-flash')
    // Providers bill cached input at a steep, PER-PROVIDER discount (DeepSeek
    // ~0.1x, Qwen/Gemini ~0.25x, OpenAI 0.5x). A flat 0.25x still overbilled
    // DeepSeek cache reads 2.5x (owner bug report 2026-07).
    const split = calcModelTurnCostUsd(model, {
      inputTokens: 0.4 * ONE_M,
      outputTokens: ONE_M,
      cacheRead: 0.6 * ONE_M,
    })
    // 0.4M × 0.09 + 0.6M × 0.09 × 0.1 + 1M × 0.18 = 0.036 + 0.0054 + 0.18
    expect(split).toBeCloseTo(0.2214, 6)
  })

  it('Qwen cached reads use the 0.25x Alibaba discount', () => {
    const cost = calcModelTurnCostUsd(getModel('or-qwen3-max'), {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: ONE_M,
    })
    expect(cost).toBeCloseTo(1.25 * 0.25, 6) // 0.3125
  })

  it('Gemini (google) cached reads use the 0.25x implicit-cache discount', () => {
    const cost = calcModelTurnCostUsd(getModel('gemini-3.1-pro'), {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: ONE_M,
    })
    expect(cost).toBeCloseTo(2 * 0.25, 6) // 0.5
  })

  it('OpenAI cached reads use the 0.5x cached-prompt rate', () => {
    const cost = calcModelTurnCostUsd(getModel('gpt-5.4'), {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: ONE_M,
    })
    expect(cost).toBeCloseTo(2.5 * 0.5, 6) // 1.25
  })
})
