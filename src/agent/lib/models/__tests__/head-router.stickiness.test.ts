/**
 * Rule 1 — thread stickiness regression guard.
 *
 * The single biggest cost leak the owner caught: a cheap (DeepSeek) or marketing
 * (Qwen) thread, when answered with a keyword-less follow-up like "??" or
 * "image ta koi?", was being re-triaged UP to Sonnet — and Sonnet then ALSO
 * spawned a paid sub-agent → double spend ($0.35 vs $0.004). These tests lock in
 * that a short / continuation follow-up INHERITS the thread's current cheap head
 * (read from the last assistant message's usage.model), while money keywords,
 * Sonnet threads, and genuinely new long questions still triage normally.
 *
 * prisma is mocked so the sticky lookup is deterministic + offline; OPENROUTER is
 * unset so triageTier fails safe to heavy (Sonnet) without a network call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

let stickyModel: string | null = null

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentMessage: {
      findFirst: vi.fn(async () => (stickyModel ? { usage: { model: stickyModel } } : null)),
    },
  },
}))

import { resolveHeadModelId } from '@/agent/lib/models/head-router'

const CONV = 'conv-test-1'

describe('resolveHeadModelId — Rule 1 thread stickiness', () => {
  beforeEach(() => {
    delete process.env.ENABLE_CHEAP_HEAD
    delete process.env.ENABLE_MARKETING_HEAD
    delete process.env.CHEAP_HEAD_MODEL_ID
    delete process.env.MARKETING_HEAD_MODEL_ID
    // no OPENROUTER key → triageTier fails safe to heavy (Sonnet), deterministic
    delete process.env.OPENROUTER_API_KEY
    stickyModel = null
  })

  it('a DeepSeek thread + "??" stays on DeepSeek (not bounced to Sonnet)', async () => {
    stickyModel = 'or-deepseek-v4-flash'
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: '??',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.modelId).toBe('or-deepseek-v4-flash')
    expect(decision.tier).toBe('light')
    expect(decision.via).toBe('sticky_followup')
  })

  it('a Qwen (marketing) thread + "??" stays on Qwen with marketing tier', async () => {
    stickyModel = 'or-qwen3-max'
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: '??',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.modelId).toBe('or-qwen3-max')
    expect(decision.tier).toBe('marketing')
    expect(decision.via).toBe('sticky_followup')
  })

  it('a continuation phrase like "image ta koi?" sticks even past the length gate', async () => {
    stickyModel = 'or-deepseek-v4-flash'
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: 'image ta koi?',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.modelId).toBe('or-deepseek-v4-flash')
    expect(decision.via).toBe('sticky_followup')
  })

  it('a genuinely new LONG question does NOT stick — it re-triages (→ Sonnet here)', async () => {
    stickyModel = 'or-deepseek-v4-flash'
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText:
        'amader notun winter collection er jonno ekta full marketing strategy banao bistarito kore',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.via).not.toBe('sticky_followup')
  })

  it('a Sonnet (anthropic) thread does NOT stick a cheap follow-up — re-triages', async () => {
    stickyModel = 'claude-sonnet-4-6'
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: '??',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.via).not.toBe('sticky_followup')
    // Re-triages UP to the heavy head — now Gemini 3.1 Pro (owner command, 2026-07).
    expect(decision.tier).toBe('heavy')
    expect(decision.modelId).toBe('gemini-3.1-pro')
  })

  it('a money keyword still forces the heavy head even on a short cheap-thread follow-up', async () => {
    stickyModel = 'or-deepseek-v4-flash'
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: 'loan ta dao',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    // Owner command (2026-07): heavy head is Gemini 3.1 Pro. Invariant preserved:
    // a money keyword never stays on the cheap DeepSeek head.
    expect(decision.tier).toBe('heavy')
    expect(decision.modelId).toBe('gemini-3.1-pro')
    expect(decision.via).toBe('deny_kw')
  })

  it('no conversationId → nothing to stick to → re-triages normally', async () => {
    stickyModel = 'or-deepseek-v4-flash'
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: '??',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
    })
    expect(decision.via).not.toBe('sticky_followup')
  })
})
