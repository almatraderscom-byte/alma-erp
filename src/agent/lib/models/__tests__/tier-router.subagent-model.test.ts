/**
 * Rule 2 — cheap sub-agent workers, with one customer-facing exception.
 *
 * When a head delegates a discrete sub-task, the internal workers run on DeepSeek
 * (the cheapest tool-capable model): researcher / marketer / content / ops all
 * carry preferredModelId='or-deepseek-v4-flash'. `ops` (staff dispatch/coordination)
 * was intentionally moved OUT of critical per owner decision — staff handling is a
 * small job, so it runs on DeepSeek too.
 *
 * EXCEPTION — `cs` (customer service) is customer-facing, so per owner decision it
 * runs on Qwen ('or-qwen3-max') for stronger Bangla quality; the higher cost is
 * accepted for replies the customer actually reads. Only `analyst` (finance / data
 * analysis) stays Claude-locked — WHILE Claude has credits. With ANTHROPIC_HEAD_DOWN
 * on (owner decision 2026-07, sanctioned in CLAUDE.md), Gemini 3.1 Pro stands in for
 * the critical tier instead of hard-failing every finance delegation.
 *
 * prisma is mocked (KV empty) so routing falls back to ROUTING_DEFAULTS, offline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentKvSetting: {
      findMany: vi.fn(async () => []),
    },
  },
}))

import { resolveSubagentModel } from '@/agent/lib/models/tier-router'
import { isAnthropicModel } from '@/agent/lib/models/registry'

describe('resolveSubagentModel — Rule 2 DeepSeek workers', () => {
  beforeEach(() => {
    // Router experiment on by default (both flags default-on); make it explicit.
    delete process.env.ENABLE_SLIM_ROUTER
    delete process.env.DELEGATION_APPROVAL
  })

  it.each(['researcher', 'marketer', 'content', 'ops'] as const)(
    'routes non-critical role "%s" to DeepSeek',
    async (role) => {
      const { tier, model } = await resolveSubagentModel(role)
      expect(tier).not.toBe('critical')
      expect(model.id).toBe('or-deepseek-v4-flash')
    },
  )

  it('routes customer-facing "cs" to Qwen (better Bangla, accepted cost)', async () => {
    const { tier, model } = await resolveSubagentModel('cs')
    expect(tier).not.toBe('critical')
    expect(model.id).toBe('or-qwen3-max')
  })

  it.each(['analyst'] as const)(
    'critical role "%s" ignores the preference and stays on Claude while Claude is up',
    async (role) => {
      process.env.ANTHROPIC_HEAD_DOWN = 'false'
      try {
        const { tier, model } = await resolveSubagentModel(role)
        expect(tier).toBe('critical')
        expect(isAnthropicModel(model.id)).toBe(true)
      } finally {
        delete process.env.ANTHROPIC_HEAD_DOWN
      }
    },
  )

  it.each(['analyst'] as const)(
    'critical role "%s" stands in on Gemini 3.1 Pro while Anthropic is down',
    async (role) => {
      delete process.env.ANTHROPIC_HEAD_DOWN // default = down (credits out)
      const { tier, model } = await resolveSubagentModel(role)
      expect(tier).toBe('critical')
      expect(model.id).toBe('gemini-3.1-pro')
    },
  )

  it('with the router experiment OFF, non-critical roles use the tier default (not the preference)', async () => {
    process.env.ENABLE_SLIM_ROUTER = 'false'
    process.env.DELEGATION_APPROVAL = 'false'
    const { model } = await resolveSubagentModel('content')
    // heavy tier default from ROUTING_DEFAULTS — NOT the DeepSeek preference
    expect(model.id).toBe('or-gemini-2.5-flash-lite')
  })
})
