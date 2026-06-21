/**
 * End-to-end reproduction of the $0.35 incident the owner reported, as a single
 * "boro SMS" scenario — the cheapest possible self-verification of Rules 1+2+3
 * without the live preview.
 *
 * Incident (owner's words): Qwen did 7-8 research steps then failed; owner typed
 * "??"; Sonnet jumped in ($0.35) AND spawned a Qwen sub-agent (double spend),
 * where DeepSeek alone would have answered for $0.004.
 *
 * What this asserts now:
 *   Turn 1 — a long multi-step MARKETING task → Qwen head (marketing tier), the
 *            orchestrator. NOT Sonnet.
 *   Turn 2 — the "??" follow-up on that Qwen thread STAYS on Qwen (sticky), so it
 *            never bounces UP to Sonnet. This is the exact cost leak, now closed.
 *   Sub-agent — when the head delegates marketing/content work, the WORKER is
 *            DeepSeek (the cheap worker), never Qwen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

let stickyModel: string | null = null

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentMessage: {
      findFirst: vi.fn(async () => (stickyModel ? { usage: { model: stickyModel } } : null)),
    },
    agentKvSetting: {
      findMany: vi.fn(async () => []),
    },
  },
}))

import { resolveHeadModelId } from '@/agent/lib/models/head-router'
import { resolveSubagentModel } from '@/agent/lib/models/tier-router'

const CONV = 'incident-conv'

describe('incident reproduction — long marketing task + "??" follow-up stays cheap', () => {
  beforeEach(() => {
    delete process.env.ENABLE_CHEAP_HEAD
    delete process.env.ENABLE_MARKETING_HEAD
    delete process.env.ENABLE_SLIM_ROUTER
    delete process.env.DELEGATION_APPROVAL
    // marketing fast-path needs a key present (value irrelevant — no network here)
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key'
    stickyModel = null
  })

  it('Turn 1: a long multi-step marketing SMS → Qwen head, not Sonnet', async () => {
    const bigSms =
      'Boss amader notun winter collection er jonno ekta full marketing plan lagbe — ' +
      'competitor der dekho, best 3 ta product select koro, protita product er jonno ' +
      'ekta sundor facebook post likhe dao ar ekta boost/ad er idea daw.'
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: bigSms,
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.tier).toBe('marketing')
    expect(decision.modelId).toBe('or-qwen3-max')
  })

  it('Turn 2: "??" after that Qwen turn stays on Qwen (no jump to Sonnet)', async () => {
    stickyModel = 'or-qwen3-max' // turn 1 ran on Qwen
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: '??',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.modelId).toBe('or-qwen3-max')
    expect(decision.modelId).not.toBe('claude-sonnet-4-6')
    expect(decision.via).toBe('sticky_followup')
  })

  it('Sub-agent work for the head goes to DeepSeek, never Qwen', async () => {
    const content = await resolveSubagentModel('content')
    const marketer = await resolveSubagentModel('marketer')
    expect(content.model.id).toBe('or-deepseek-v4-flash')
    expect(marketer.model.id).toBe('or-deepseek-v4-flash')
  })
})
