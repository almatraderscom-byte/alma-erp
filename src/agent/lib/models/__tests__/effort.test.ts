import { describe, it, expect } from 'vitest'
import {
  anthropicThinkingBudget,
  clampEffort,
  geminiThinkingLevel,
  parseEffortSetting,
  type EffortSupport,
} from '@/agent/lib/models/effort'
import { MODEL_REGISTRY, getModel } from '@/agent/lib/models/registry'

/**
 * The owner's thinking-level picker is only trustworthy if a level he picks
 * either RUNS or visibly steps down — never silently means something else and
 * never reaches a provider that would reject it. These are the rules that keep
 * that true; the per-model lists themselves were verified against provider docs
 * on 2026-08-21 (see effort.ts header).
 */
describe('effort levels', () => {
  const gemini: EffortSupport = { dialect: 'gemini_thinking_level', levels: ['low', 'medium', 'high'] }
  const opus: EffortSupport = { dialect: 'anthropic_effort', levels: ['low', 'medium', 'high', 'xhigh', 'max'] }

  it('passes a level the model really supports through unchanged', () => {
    expect(clampEffort('high', gemini)).toBe('high')
    expect(clampEffort('max', opus)).toBe('max')
  })

  it('steps DOWN to the model ceiling, never up', () => {
    // Gemini has nothing above `high` — "Max" must run high, not 400.
    expect(clampEffort('max', gemini)).toBe('high')
    expect(clampEffort('xhigh', gemini)).toBe('high')
    // Sonnet 4.6 predates xhigh.
    const sonnet: EffortSupport = { dialect: 'anthropic_effort', levels: ['low', 'medium', 'high', 'max'] }
    expect(clampEffort('xhigh', sonnet)).toBe('high')
  })

  it('falls to the cheapest level when the pick is below everything offered', () => {
    const highOnly: EffortSupport = { dialect: 'openrouter_effort', levels: ['high'] }
    expect(clampEffort('low', highOnly)).toBe('high')
  })

  it('is null (Auto) when there is no dial or no pick — nothing is sent', () => {
    expect(clampEffort('high', undefined)).toBeNull()
    expect(clampEffort('high', { dialect: 'openai_effort', levels: [] })).toBeNull()
    expect(clampEffort(null, opus)).toBeNull()
    expect(clampEffort(undefined, opus)).toBeNull()
  })

  it('accepts only real levels, treats auto/null as clear, and refuses garbage', () => {
    expect(parseEffortSetting('high')).toBe('high')
    expect(parseEffortSetting('auto')).toBeNull()
    expect(parseEffortSetting(null)).toBeNull()
    // undefined = "reject this write" (the route 400s) rather than a silent Auto.
    expect(parseEffortSetting('HIGH')).toBeUndefined()
    expect(parseEffortSetting('turbo')).toBeUndefined()
    expect(parseEffortSetting(3)).toBeUndefined()
  })

  it('maps every level onto Gemini\'s real enum (no value above high)', () => {
    expect(geminiThinkingLevel('low')).toBe('low')
    expect(geminiThinkingLevel('medium')).toBe('medium')
    expect(geminiThinkingLevel('high')).toBe('high')
    expect(geminiThinkingLevel('xhigh')).toBe('high')
    expect(geminiThinkingLevel('max')).toBe('high')
  })

  it('keeps an Anthropic thinking budget inside the API bounds (≥1024, < max_tokens)', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const budget = anthropicThinkingBudget(level, 8192)
      expect(budget).toBeGreaterThanOrEqual(1024)
      expect(budget).toBeLessThan(8192)
    }
    // Deeper levels really do buy more thinking.
    expect(anthropicThinkingBudget('max', 8192)).toBeGreaterThan(anthropicThinkingBudget('low', 8192))
    // A small max_tokens must not produce an illegal budget.
    expect(anthropicThinkingBudget('max', 2048)).toBeLessThan(2048)
    expect(anthropicThinkingBudget('low', 1200)).toBeGreaterThanOrEqual(1024)
  })
})

describe('registry effort declarations', () => {
  it('declares levels in ascending order with no duplicates', () => {
    const order = ['low', 'medium', 'high', 'xhigh', 'max']
    for (const model of MODEL_REGISTRY) {
      if (!model.effort) continue
      const ranks = model.effort.levels.map((l) => order.indexOf(l))
      expect(ranks, model.id).toEqual([...ranks].sort((a, b) => a - b))
      expect(new Set(model.effort.levels).size, model.id).toBe(model.effort.levels.length)
    }
  })

  it('never offers a level a provider dialect cannot express', () => {
    for (const model of MODEL_REGISTRY) {
      if (!model.effort) continue
      if (model.effort.dialect === 'gemini_thinking_level') {
        // Gemini's enum stops at high — offering max here would be a lie.
        expect(model.effort.levels, model.id).not.toContain('max')
        expect(model.effort.levels, model.id).not.toContain('xhigh')
      }
    }
  })

  it('pairs each dialect with the provider that speaks it', () => {
    const byDialect: Record<string, string[]> = {
      anthropic_effort: ['anthropic'],
      anthropic_budget: ['anthropic'],
      gemini_thinking_level: ['google'],
      openai_effort: ['openai'],
      openrouter_effort: ['openrouter', 'xai'],
    }
    for (const model of MODEL_REGISTRY) {
      if (!model.effort) continue
      expect(byDialect[model.effort.dialect], model.id).toContain(model.provider)
    }
  })

  it('keeps Haiku 4.5 on the budget dialect — it REJECTS output_config.effort', () => {
    expect(getModel('claude-haiku-4-5').effort?.dialect).toBe('anthropic_budget')
  })
})
