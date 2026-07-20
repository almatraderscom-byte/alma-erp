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
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

  // 2026-07-14 word-boundary regression: bare 'ke'/'ase' used to match INSIDE
  // words ('keno', 'karon ase'), silently routing non-routine questions to the
  // cheap head. These must NOT take the routine fast-path.
  it.each([
    'notun design keno late hocche? karon ase?',
    'কেন আজ delivery ase nai bolo to',
  ])('a ke/ase substring inside another word is NOT a routine lookup: %s', async (msg) => {
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: msg,
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    expect(decision.via).not.toBe('routine_kw')
  })

  it('a money keyword still forces the heavy head, never the cheap DeepSeek head', async () => {
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: 'aj salary koto hisab koro',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    // Owner command (2026-07-18): heavy head is Grok 4.20 (Gemini off). The real
    // invariant is the tier — money/sensitive must never fall to the cheap head.
    expect(decision.tier).toBe('heavy')
    expect(decision.modelId).toBe('xai-grok-4.20')
  })
})

describe('resolveHeadModelId — explicit model selection vs Auto', () => {
  // Owner rule 2026-07-20: the Monitor toggle is the ONE owner-facing switch. If the
  // owner has NOT turned the model off in Monitor and picks it in chat, it RUNS — no
  // env flag involved. Redirect only when the model is Monitor-OFF or the API key is
  // missing (Claude can't physically run without a key).
  describe('with Anthropic head available (key present, Monitor on)', () => {
    beforeAll(() => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    })
    afterAll(() => {
      delete process.env.ANTHROPIC_API_KEY
    })

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

    it('an ANTHROPIC_HEAD_DOWN env value does NOT affect an explicit pick', async () => {
      process.env.ANTHROPIC_HEAD_DOWN = 'true'
      try {
        const decision = await resolveHeadModelId({
          requestedModelId: 'claude-opus-4-8',
          lastUserText: 'aj koto sale holo',
          personalMode: false,
          businessId: 'ALMA_LIFESTYLE',
        })
        expect(decision.tier).toBe('explicit')
        expect(decision.modelId).toBe('claude-opus-4-8')
      } finally {
        delete process.env.ANTHROPIC_HEAD_DOWN
      }
    })
  })

  describe('redirects a Claude pick only on a real down signal', () => {
    it('redirects Opus to the heavy head when no API key is configured', async () => {
      delete process.env.ANTHROPIC_API_KEY
      const decision = await resolveHeadModelId({
        requestedModelId: 'claude-opus-4-8',
        lastUserText: 'aj koto sale holo',
        personalMode: false,
        businessId: 'ALMA_LIFESTYLE',
      })
      expect(decision.tier).toBe('heavy')
      expect(decision.via).toBe('anthropic_down_explicit_redirect')
    })

    it('a non-Anthropic explicit pin is honoured regardless of key/env', async () => {
      delete process.env.ANTHROPIC_API_KEY
      const decision = await resolveHeadModelId({
        requestedModelId: 'or-deepseek-v4-flash',
        lastUserText: 'aj koto sale holo',
        personalMode: false,
        businessId: 'ALMA_LIFESTYLE',
      })
      expect(decision.tier).toBe('explicit')
      expect(decision.modelId).toBe('or-deepseek-v4-flash')
    })
  })

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
