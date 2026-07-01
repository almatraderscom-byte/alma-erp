/**
 * Head-router regression guard for two owner-requested behaviours:
 *
 *  1. Routine status lookups (today's sales, who is in the office, stock / order
 *     counts) must route to the cheap head (DeepSeek) DIRECTLY via the regex
 *     fast-path — no triage network call, so this is deterministic + offline.
 *
 *  2. Explicit model selection: a concrete known model id (INCLUDING Sonnet) is
 *     honoured exactly ("select a model → that real model runs"); the 'auto'
 *     sentinel falls through to the cost-optimized router (current behaviour).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { resolveHeadModelId } from '@/agent/lib/models/head-router'

const ROUTINE_MESSAGES = [
  'aj koto sale holo',
  'ajke koto bikri hoyeche',
  'ke ke office e ase',
  'ke ase office e aj',
  'kara hajir ase aj',
  'stock koto ase',
  'koto order pending',
  'attendance dao',
]

describe('resolveHeadModelId — routine fast-path', () => {
  beforeAll(() => {
    delete process.env.ENABLE_CHEAP_HEAD
    delete process.env.CHEAP_HEAD_MODEL_ID
  })

  it.each(ROUTINE_MESSAGES)('routes routine lookup to the cheap head (DeepSeek): %s', async (msg) => {
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: msg,
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    expect(decision.tier).toBe('light')
    expect(decision.modelId).toBe('or-deepseek-v4-flash')
    expect(decision.via).toBe('routine_kw')
  })

  it('a money keyword still forces the heavy head, never the cheap DeepSeek head', async () => {
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: 'aj salary koto hisab koro',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    // Owner command (2026-07): heavy head is Gemini 3.1 Pro (Anthropic credits dead).
    // The real invariant is the tier — money/sensitive must never fall to the cheap head.
    expect(decision.tier).toBe('heavy')
    expect(decision.modelId).toBe('gemini-3.1-pro')
  })
})

describe('resolveHeadModelId — explicit model selection vs Auto', () => {
  it.each(['claude-opus-4-8', 'or-deepseek-v4-flash', 'claude-sonnet-4-6'])(
    'honours an explicitly selected model exactly: %s',
    async (modelId) => {
      const decision = await resolveHeadModelId({
        requestedModelId: modelId,
        // Routine text would otherwise route to DeepSeek — explicit pin must win.
        lastUserText: 'aj koto sale holo',
        personalMode: false,
        businessId: 'ALMA_LIFESTYLE',
      })
      expect(decision.tier).toBe('explicit')
      expect(decision.modelId).toBe(modelId)
    },
  )

  it("'auto' sentinel falls through to the cost-optimized router", async () => {
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: 'aj koto sale holo',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    expect(decision.tier).toBe('light')
    expect(decision.modelId).toBe('or-deepseek-v4-flash')
  })

  it('an unknown requested id is ignored (not honoured), falls through to router', async () => {
    const decision = await resolveHeadModelId({
      requestedModelId: 'totally-made-up-model',
      lastUserText: 'aj koto sale holo',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    expect(decision.tier).not.toBe('explicit')
  })
})
