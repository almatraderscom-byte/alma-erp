/**
 * Rule 2 — DeepSeek is the cheap sub-agent worker.
 *
 * Owner rule after the $0.35 incident: when a head delegates a discrete sub-task,
 * the WORKER should be DeepSeek (the cheapest tool-capable model) — never Qwen.
 * The non-critical specialist roles (researcher / marketer / content / cs / ops)
 * now carry preferredModelId='or-deepseek-v4-flash', and resolveSubagentModel
 * honors it while the router experiment is on. `ops` (staff dispatch/coordination)
 * was intentionally moved OUT of critical per owner decision — staff handling is a
 * small job, so it runs on DeepSeek too. Only `analyst` (finance / data analysis)
 * stays hard-locked to Claude.
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

  it.each(['researcher', 'marketer', 'content', 'cs', 'ops'] as const)(
    'routes non-critical role "%s" to DeepSeek',
    async (role) => {
      const { tier, model } = await resolveSubagentModel(role)
      expect(tier).not.toBe('critical')
      expect(model.id).toBe('or-deepseek-v4-flash')
    },
  )

  it.each(['analyst'] as const)(
    'critical role "%s" ignores the preference and stays on Claude',
    async (role) => {
      const { tier, model } = await resolveSubagentModel(role)
      expect(tier).toBe('critical')
      expect(isAnthropicModel(model.id)).toBe(true)
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
