/**
 * Phase 31 — Layer B: the FULL head decision (resolveHeadModelId) executed for
 * real over the continuity corpus, with its two external effects faked:
 *   - prisma sticky-head lookup  → serves the fixture's context.stickyModelId
 *   - OpenRouter classifiers     → serve the fixture's fakes.triageTier /
 *                                  fakes.personalClassification
 *
 * This is "real router code with fake external effects" per the roadmap —
 * NOT a re-implementation: deny/call/personal/marketing/routine/sticky logic
 * all run inside the real function. The LangGraph shadow graph then replays
 * each decision and must never score a hard disagreement.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { join } from 'node:path'

// Per-case fakes, set by the loop below and read by the module mocks.
const fake = {
  stickyModelId: null as string | null,
  triageTier: 'heavy' as string,
  personalClassification: 'work' as string,
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentMessage: {
      findFirst: async () =>
        fake.stickyModelId ? { usage: { model: fake.stickyModelId } } : null,
    },
    agentEvent: { create: async () => ({}) },
  },
}))

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = {
      completions: {
        create: async (params: { response_format?: { json_schema?: { name?: string } } }) => {
          const schema = params.response_format?.json_schema?.name
          const content =
            schema === 'personal_classification'
              ? JSON.stringify({ classification: fake.personalClassification })
              : JSON.stringify({ tier: fake.triageTier })
          return { choices: [{ message: { content } }], usage: undefined }
        },
      },
    }
  },
}))

import { loadCorpus, replayDecisionTurn, REPLAY_NOW } from '@/agent/replay/run-agent-replay'
import { resolveHeadModelId, classifyHeadFastPath } from '@/agent/lib/models/head-router'
import { runTurnGraphShadow } from '@/agent/lib/graph/turn-graph-shadow'
import type { ReplayCaseV2 } from '@/agent/replay/replay-types'

const FIXTURES = join(process.cwd(), 'src/agent/replay/fixtures')

beforeAll(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key-not-real')
  vi.stubEnv('AGENT_LANGGRAPH_TURN', 'shadow')
  vi.stubEnv('ENABLE_CHEAP_HEAD', 'true')
  vi.stubEnv('ENABLE_MARKETING_HEAD', 'true')
  vi.stubEnv('ENABLE_PERSONAL_EMPATHY_MODE', 'true')
})

function armFakes(c: ReplayCaseV2): void {
  fake.stickyModelId = c.context?.stickyModelId ?? null
  fake.triageTier = c.fakes?.triageTier ?? 'heavy'
  fake.personalClassification = c.fakes?.personalClassification ?? 'work'
}

describe('phase 31 layer B — real head decision over the corpus', () => {
  it('resolves every head-tier expectation through the REAL resolveHeadModelId', async () => {
    const { cases } = loadCorpus(FIXTURES)
    const tierCases = cases.filter(
      (c) => c.expect2.headTier !== undefined || c.expect2.listenSuppressed !== undefined,
    )
    expect(tierCases.length).toBeGreaterThanOrEqual(40)

    const failures: string[] = []
    let listenFindings = 0
    for (const c of tierCases) {
      armFakes(c)
      const r = await replayDecisionTurn(c, { now: REPLAY_NOW, resolveHead: resolveHeadModelId })
      for (const k of r.checks) {
        if (k.check === 'headTier' && !k.pass) {
          failures.push(`${c.id}: headTier exp=${String(k.expected)} got=${String(k.actual)}`)
        }
        if (k.check === 'listenSuppressed' && !k.pass) listenFindings += 1
      }
      expect(r.skipped.filter((s) => s.startsWith('headTier'))).toEqual([])
    }

    // BASELINE LOCK: every head-tier expectation holds on current code…
    expect(failures).toEqual([])
    // …except ONE known listen finding: a quiet follow-up right after an
    // emotional exchange ("jani na, emni") re-enters work mode because listen
    // mode has no conversation-state persistence. Phase 36 target.
    expect(listenFindings).toBe(1)
  })

  it('sticky-head inheritance: cheap/marketing inherited; anthropic and worker-only are not', async () => {
    const { cases } = loadCorpus(FIXTURES)
    const expectations: Array<[string, string]> = [
      ['rc-0134-cont-sticky-deepseek', 'light'],
      ['rc-0135-cont-sticky-qwen', 'marketing'],
      ['rc-0136-cont-sticky-anthropic-not-inherited', 'heavy'],
      ['rc-0137-cont-sticky-worker-only-not-inherited', 'light'],
      ['rc-0138-cont-sticky-money-overrides', 'heavy'],
    ]
    for (const [id, tier] of expectations) {
      const c = cases.find((x) => x.id === id)
      expect(c, id).toBeDefined()
      armFakes(c!)
      const d = await resolveHeadModelId({
        requestedModelId: null,
        lastUserText: c!.latestMessage,
        personalMode: false,
        businessId: 'ALMA_LIFESTYLE',
        conversationId: `replay-${id}`,
      })
      expect(d.tier, id).toBe(tier)
    }
  })

  it('listen mode: personal messages suppress work on every surface, mixed asks stay work', async () => {
    const { cases } = loadCorpus(FIXTURES)
    const personal = cases.filter(
      (c) => c.category === 'personal_listen' && c.fakes?.personalClassification === 'personal' && c.expect2.headTier === 'personal',
    )
    expect(personal.length).toBeGreaterThanOrEqual(12)
    for (const c of personal) {
      armFakes(c)
      const d = await resolveHeadModelId({
        requestedModelId: null,
        lastUserText: c.latestMessage,
        personalMode: false,
        businessId: 'ALMA_LIFESTYLE',
        conversationId: `replay-${c.id}`,
      })
      expect(d.tier, c.id).toBe('personal')
      expect(d.via, c.id).toBe('personal_emotional')
    }
    const mixed = cases.filter((c) => c.id.includes('listen-mixed-'))
    expect(mixed.length).toBe(4)
    for (const c of mixed) {
      armFakes(c)
      const d = await resolveHeadModelId({
        requestedModelId: null,
        lastUserText: c.latestMessage,
        personalMode: false,
        businessId: 'ALMA_LIFESTYLE',
        conversationId: `replay-${c.id}`,
      })
      expect(d.tier, c.id).not.toBe('personal')
    }
  })

  it('LangGraph shadow graph never hard-disagrees with the live decision it mirrors', async () => {
    const { cases } = loadCorpus(FIXTURES)
    const tierCases = cases.filter((c) => c.expect2.headTier !== undefined)
    let scored = 0
    let recorded = 0
    for (const c of tierCases) {
      armFakes(c)
      const d = await resolveHeadModelId({
        requestedModelId: null,
        lastUserText: c.latestMessage,
        personalMode: false,
        businessId: 'ALMA_LIFESTYLE',
        conversationId: `replay-${c.id}`,
      })
      const rec = await runTurnGraphShadow({
        lastUserText: c.latestMessage,
        headTier: d.tier,
        headVia: d.via,
        listenMode: d.tier === 'personal',
        toolGroups: [],
        toolCount: 0,
        maxIterations: 12,
      })
      expect(rec, c.id).not.toBeNull()
      recorded += 1
      if (rec!.agree !== null) {
        scored += 1
        expect(rec!.agree, `${c.id} via=${d.via} fastPath=${rec!.fastPath}`).toBe(true)
      }
    }
    expect(recorded).toBe(tierCases.length)
    // Deterministic kinds (deny/call/marketing/routine) must actually score.
    expect(scored).toBeGreaterThanOrEqual(20)
  })

  it('cross-surface: the head decision is identical from web, native, and telegram', async () => {
    const { cases } = loadCorpus(FIXTURES)
    const xs = cases.filter((c) => c.category === 'cross_surface' && c.expect2.headTier !== undefined)
    for (const c of xs) {
      armFakes(c)
      // The head resolver takes no surface input — same text + state must
      // yield the same tier regardless of where the message came from.
      const d1 = await resolveHeadModelId({ requestedModelId: null, lastUserText: c.latestMessage, personalMode: false, businessId: 'ALMA_LIFESTYLE', conversationId: `replay-${c.id}-a` })
      const d2 = await resolveHeadModelId({ requestedModelId: null, lastUserText: c.latestMessage, personalMode: false, businessId: 'ALMA_LIFESTYLE', conversationId: `replay-${c.id}-b` })
      expect(d1.tier).toBe(d2.tier)
      expect(d1.tier, c.id).toBe(c.expect2.headTier)
    }
  })

  it('fast-path re-derivation matches inside Layer B exactly as in the pure layer', () => {
    const { cases } = loadCorpus(FIXTURES)
    for (const c of cases) {
      if (c.expect2.fastPath === undefined) continue
      expect(classifyHeadFastPath(c.latestMessage), c.id).toBe(c.expect2.fastPath)
    }
  })
})
