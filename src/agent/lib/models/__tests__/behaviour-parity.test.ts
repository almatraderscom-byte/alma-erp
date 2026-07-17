import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ToolLedgerEntry } from '../../claim-verifier'

/**
 * BP4 — the parity proof. The owner's real head is Grok 4.20 (xAI-direct); the
 * alternates are what he might switch to. The behaviour-parity layer must treat
 * ALL of them identically — which it does BY CONSTRUCTION, because every gate
 * helper takes only (message text, tool ledger, flags) and never the model.
 */
const HEADS = {
  grokXaiDirect: { apiModel: 'grok-4.20', provider: 'xai', thinking: 'level' },
  grokOpenRouter: { apiModel: 'x-ai/grok-4.20', provider: 'openrouter', thinking: 'level' },
  deepseek: { apiModel: 'deepseek/deepseek-v4-flash', provider: 'openrouter', thinking: 'level' },
  gemini: { apiModel: 'gemini-3.1-pro', provider: 'google', thinking: 'level' },
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadAllGatesOn() {
  vi.stubEnv('AGENT_UNIFORM_SAMPLING', 'on')
  vi.stubEnv('AGENT_PLAN_GATE', 'on')
  vi.stubEnv('AGENT_GROUNDING_GATE', 'on')
  vi.stubEnv('AGENT_FACT_GATE', 'on')
  vi.stubEnv('AGENT_CONSTITUTION', 'on')
  vi.stubEnv('AGENT_HEAD_PARITY', 'on')
  vi.resetModules()
  return {
    gen: await import('../generation-params'),
    cap: await import('../head-tool-cap'),
    req: await import('../../owner-turn-requirements'),
    cv: await import('../../claim-verifier'),
    repair: await import('../tool-arg-repair'),
    sp: await import('../../system-prompt'),
  }
}

describe('behaviour parity — one discipline for every head model', () => {
  it('P10 tool cap: the owner Grok head is capped whether xAI-direct OR OpenRouter', async () => {
    const { cap } = await loadAllGatesOn()
    expect(cap.computeHeadToolCap(HEADS.grokXaiDirect)).toBe(200)
    expect(cap.computeHeadToolCap(HEADS.grokOpenRouter)).toBe(200)
    expect(cap.computeHeadToolCap(HEADS.gemini)).toBe(Infinity)
  })

  it('P9 output cap: every reasoning head gets the SAME max_tokens (no accidental provider default)', async () => {
    const { gen } = await loadAllGatesOn()
    const grok = gen.resolveGenerationParams({ thinking: HEADS.grokXaiDirect.thinking })
    const deepseek = gen.resolveGenerationParams({ thinking: HEADS.deepseek.thinking })
    const gemini = gen.resolveGenerationParams({ thinking: HEADS.gemini.thinking })
    expect(grok).toEqual(deepseek)
    expect(deepseek).toEqual(gemini)
    expect(grok).toEqual({ maxTokens: 8192 })
  })

  it('gates depend only on (text, ledger) → identical disciplined trajectory for any head', async () => {
    const { req, cv, repair, sp } = await loadAllGatesOn()
    // ground-before-answer fires on a live-data question
    expect(req.deriveOwnerTurnRequirements('আজকের অর্ডার কত?').groundingRequired).toBe(true)
    // plan-first fires on clearly multi-step work
    expect(req.deriveOwnerTurnRequirements('প্রথমে অর্ডার তারপর প্যাক তারপর কুরিয়ারে দাও').planFirst).toBe(true)
    // a fabricated stat is caught
    const noTools: ToolLedgerEntry[] = []
    expect(cv.detectFabricatedStatViolations('আজ ৫টি অর্ডার হয়েছে', noTools)).toHaveLength(1)
    // a malformed tool call is salvaged rather than silently failed
    const r = repair.repairToolArgs('```json\n{"a":1,}\n```')
    expect(r.ok && r.value).toEqual({ a: 1 })
    // the constitution anchors the prompt
    const text = sp.buildSystemPrompt().map((b) => b.text ?? '').join('\n')
    expect(text).toContain('সংবিধান — সবার আগে')
  })
})
