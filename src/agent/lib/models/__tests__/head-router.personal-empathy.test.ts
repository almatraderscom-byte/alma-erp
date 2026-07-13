/**
 * Personal / emotional message → LISTEN mode routing (tier 'personal').
 *
 * The 2026-07-14 incident: the owner said "hotash lagche, kichu valo lage na" and
 * the agent ran generate_image / ads / list_owner_todos instead of listening.
 * These tests lock in that (1) a confirmed personal message routes to tier
 * 'personal', (2) a work message that merely CONTAINS an emotion word does NOT
 * (owner rule: accurately tell "I'm emotional" from "do work"), (3) money /
 * destructive keywords still win, (4) the kill switch works, and (5) the confirming
 * classifier is skipped entirely for plainly-work traffic (no added cost).
 *
 * prisma + openai are mocked so routing is deterministic and offline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The classifier's reply, per test. The mocked OpenAI branches on the system
// prompt: the personal classifier ("... personal or work") returns this; the
// triage classifier ("... light, marketing, or heavy") returns a safe 'heavy'.
let classifyReply = 'work'
let personalCallCount = 0

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = {
      completions: {
        create: vi.fn(async (params: { messages: Array<{ role: string; content: string }> }) => {
          const sys = params.messages[0]?.content ?? ''
          if (sys.includes('personal or work')) {
            personalCallCount++
            return { choices: [{ message: { content: classifyReply } }], usage: { prompt_tokens: 20, completion_tokens: 1 } }
          }
          return { choices: [{ message: { content: 'heavy' } }], usage: { prompt_tokens: 20, completion_tokens: 1 } }
        }),
      },
    }
    constructor(_opts: unknown) {}
  },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentMessage: { findFirst: vi.fn(async () => null) },
    agentCostEvent: { create: vi.fn(async () => ({ id: 'x' })), upsert: vi.fn(async () => ({ id: 'x' })) },
  },
}))

import { resolveHeadModelId } from '@/agent/lib/models/head-router'

const base = {
  requestedModelId: 'auto',
  personalMode: false,
  businessId: 'ALMA_LIFESTYLE' as const,
  conversationId: 'conv-empathy-1',
}

describe('resolveHeadModelId — personal / emotional LISTEN routing', () => {
  beforeEach(() => {
    delete process.env.ENABLE_CHEAP_HEAD
    delete process.env.ENABLE_MARKETING_HEAD
    delete process.env.ENABLE_PERSONAL_EMPATHY_MODE
    process.env.OPENROUTER_API_KEY = 'test-key'
    classifyReply = 'work'
    personalCallCount = 0
  })

  it('the exact incident message, confirmed personal → tier "personal"', async () => {
    classifyReply = 'personal'
    const d = await resolveHeadModelId({ ...base, lastUserText: 'Amr onk hotash lagche, kichu valo lage na keno? Er kono karon ase?' })
    expect(d.tier).toBe('personal')
    expect(d.via).toBe('personal_emotional')
  })

  it('a work message that merely contains an emotion word → NOT personal', async () => {
    classifyReply = 'work' // classifier correctly rejects "customer is frustrated" as work
    const d = await resolveHeadModelId({ ...base, lastUserText: 'ekjon kastomer khub hotash hoye chole geche, ki korbo?' })
    expect(d.tier).not.toBe('personal')
    expect(personalCallCount).toBe(1) // the hint fired, classifier was consulted, said work
  })

  it('feeling + a money/destructive command → money guard wins, classifier never consulted', async () => {
    classifyReply = 'personal'
    const d = await resolveHeadModelId({ ...base, lastUserText: 'mon valo nei, oi staff er salary ta delete kore dao' })
    expect(d.tier).toBe('heavy')
    expect(d.via).toBe('deny_kw')
    expect(personalCallCount).toBe(0)
  })

  it('kill switch ENABLE_PERSONAL_EMPATHY_MODE=false → never routes personal', async () => {
    process.env.ENABLE_PERSONAL_EMPATHY_MODE = 'false'
    classifyReply = 'personal'
    const d = await resolveHeadModelId({ ...base, lastUserText: 'amar mon khub kharap, kichu valo lagche na' })
    expect(d.tier).not.toBe('personal')
    expect(personalCallCount).toBe(0) // classifier skipped entirely when disabled
  })

  it('plainly-work traffic never triggers the classifier (no added cost)', async () => {
    const d = await resolveHeadModelId({ ...base, lastUserText: 'aj koto sale hoise?' })
    expect(d.tier).not.toBe('personal')
    expect(personalCallCount).toBe(0) // regex hint never matched → classifier never called
  })

  it('classifier failure / no key falls back to work (never misroutes to personal)', async () => {
    delete process.env.OPENROUTER_API_KEY // openRouterClient() → null → classify returns false
    const d = await resolveHeadModelId({ ...base, lastUserText: 'amar mon valo nei, hotash lagche' })
    expect(d.tier).not.toBe('personal')
  })
})
