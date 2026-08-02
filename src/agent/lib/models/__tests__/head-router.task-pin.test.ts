/**
 * P0-1 — a job keeps its head (foundation audit, owner 2026-08-02).
 *
 * The owner watched one task start on "ALMA · GPT-5.6 Luna" and continue on
 * "ALMA · DeepSeek V4 Flash": routing was per MESSAGE, so nothing but the
 * transcript survived the switch. These tests lock the three properties that
 * make the pin safe to ship:
 *
 *   1. it HOLDS across the turns of one job,
 *   2. it may ESCALATE (light → heavy) but never downgrade, and a money keyword
 *      is decided before the pin is even read,
 *   3. an approval CONTINUATION resumes on the job's head even after the pin's
 *      window lapsed while the card waited for a tap.
 *
 * prisma is mocked, OPENROUTER_API_KEY is unset (triage fails safe to heavy), so
 * every case is deterministic and offline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface PinRow {
  pinnedHeadModel: string | null
  pinnedHeadTier: string | null
  pinnedHeadVia: string | null
  pinnedHeadUntil: Date | null
}

let pinRow: PinRow | null = null
let stickyModel: string | null = null
const updates: Record<string, unknown>[] = []
const wheres: Record<string, unknown>[] = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentMessage: {
      findFirst: vi.fn(async () => (stickyModel ? { usage: { model: stickyModel } } : null)),
    },
    agentConversation: {
      findUnique: vi.fn(async () => pinRow),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data)
        return {}
      }),
      // The real write is a conditional updateMany — the test records both the
      // data AND the where clause, because the never-downgrade and
      // don't-slide-the-window rules now live in that clause.
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        wheres.push(where)
        updates.push(data)
        return { count: 1 }
      }),
    },
  },
}))

import { resolveHeadModelId } from '@/agent/lib/models/head-router'
import { readHeadPin, rememberHeadPin, headTierRank, headPinClearFields } from '@/agent/lib/models/head-pin'

const CONV = 'conv-pin-1'
const HOUR = 60 * 60 * 1000

const livePin = (modelId: string, tier: string): PinRow => ({
  pinnedHeadModel: modelId,
  pinnedHeadTier: tier,
  pinnedHeadVia: 'triage',
  pinnedHeadUntil: new Date(Date.now() + 10 * 60 * 1000),
})

const expiredPin = (modelId: string, tier: string): PinRow => ({
  ...livePin(modelId, tier),
  pinnedHeadUntil: new Date(Date.now() - HOUR),
})

describe('resolveHeadModelId — task-level head pin', () => {
  beforeEach(() => {
    delete process.env.ENABLE_CHEAP_HEAD
    delete process.env.ENABLE_MARKETING_HEAD
    delete process.env.CHEAP_HEAD_MODEL_ID
    delete process.env.MARKETING_HEAD_MODEL_ID
    delete process.env.OPENROUTER_API_KEY
    delete process.env.HEAD_TASK_PIN
    pinRow = null
    stickyModel = null
    updates.length = 0
  })

  it('holds the job on its pinned heavy head instead of dropping to the cheap one', async () => {
    // Exactly the owner's screenshot: a heavy job, then a routine-looking line
    // that the ROUTINE_RE fast path would have sent to DeepSeek.
    pinRow = livePin('gpt-5.6-luna', 'heavy')
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: 'aj koto sale holo',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.modelId).toBe('gpt-5.6-luna')
    expect(decision.tier).toBe('heavy')
    expect(decision.via).toBe('task_pin')
  })

  it('a money keyword still forces the heavy head even under a LIGHT pin', async () => {
    // The safety argument in one test: the deny guard runs before the pin is read.
    pinRow = livePin('or-deepseek-v4-flash', 'light')
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: 'salary ta delete kore dao',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.tier).toBe('heavy')
    expect(decision.modelId).toBe('gpt-5.6-luna')
    expect(decision.via).toBe('deny_kw')
  })

  it('a light pin ESCALATES when the message itself routes heavy', async () => {
    pinRow = livePin('or-deepseek-v4-flash', 'light')
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText:
        'agami mash er jonno purro business er ekta bistarito plan banao, ki ki jaygay poisa lagbe seta bujhiye dao',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.tier).toBe('heavy')
    expect(decision.via).toContain('pin_escalate')
  })

  it('a light pin holds when the fresh route is no higher', async () => {
    pinRow = livePin('or-deepseek-v4-flash', 'light')
    stickyModel = 'or-deepseek-v4-flash'
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: 'stock koto ache',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.modelId).toBe('or-deepseek-v4-flash')
    expect(decision.via).toBe('task_pin')
  })

  it('an expired pin does not hold a fresh message', async () => {
    pinRow = expiredPin('gpt-5.6-luna', 'heavy')
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: 'aj koto sale holo',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.via).toBe('routine_kw')
    expect(decision.modelId).toBe('or-deepseek-v4-flash')
  })

  it('an approval continuation resumes on the job head even with an EXPIRED pin', async () => {
    // A card can sit unanswered for hours; the tap still belongs to that job.
    pinRow = expiredPin('or-deepseek-v4-flash', 'light')
    const decision = await resolveHeadModelId({
      // The chat route passes the default heavy head for internal turns — the
      // pin must win over it, which is the bug this line used to hide.
      requestedModelId: 'gpt-5.6-luna',
      lastUserText: 'continue',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
      continuation: true,
    })
    expect(decision.modelId).toBe('or-deepseek-v4-flash')
    expect(decision.via).toBe('task_pin_continuation')
  })

  it('a continuation with NO pin falls back to the requested head (Telegram/first turn)', async () => {
    pinRow = null
    const decision = await resolveHeadModelId({
      requestedModelId: 'gpt-5.6-luna',
      lastUserText: 'continue',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
      continuation: true,
    })
    expect(decision.modelId).toBe('gpt-5.6-luna')
    expect(decision.via).toBe('explicit')
  })

  it('HEAD_TASK_PIN=off restores per-message routing exactly', async () => {
    process.env.HEAD_TASK_PIN = 'off'
    pinRow = livePin('gpt-5.6-luna', 'heavy')
    const decision = await resolveHeadModelId({
      requestedModelId: 'auto',
      lastUserText: 'aj koto sale holo',
      personalMode: false,
      businessId: 'ALMA_LIFESTYLE',
      conversationId: CONV,
    })
    expect(decision.via).toBe('routine_kw')
    expect(decision.modelId).toBe('or-deepseek-v4-flash')
  })
})

describe('head-pin storage rules', () => {
  beforeEach(() => {
    delete process.env.HEAD_TASK_PIN
    updates.length = 0
    wheres.length = 0
  })

  it('never pins listen mode — that tier withholds business tools on purpose', async () => {
    await rememberHeadPin(CONV, { modelId: 'gpt-5.6-luna', tier: 'personal', via: 'personal_emotional' })
    expect(updates).toHaveLength(0)
    expect(readHeadPin(livePin('gpt-5.6-luna', 'personal'))).toBeNull()
  })

  it('writes model + tier + via + expiry, and refuses an unknown model id', async () => {
    await rememberHeadPin(CONV, { modelId: 'or-deepseek-v4-flash', tier: 'light', via: 'routine_kw' })
    expect(updates).toHaveLength(1)
    expect(updates[0].pinnedHeadModel).toBe('or-deepseek-v4-flash')
    expect(updates[0].pinnedHeadTier).toBe('light')
    expect(updates[0].pinnedHeadVia).toBe('routine_kw')
    expect(updates[0].pinnedHeadUntil).toBeInstanceOf(Date)

    await rememberHeadPin(CONV, { modelId: 'no-such-model', tier: 'heavy', via: 'triage' })
    expect(updates).toHaveLength(1)
  })

  it('ranks tiers so a pin can only ever escalate', () => {
    expect(headTierRank('light')).toBeLessThan(headTierRank('marketing'))
    expect(headTierRank('marketing')).toBeLessThan(headTierRank('heavy'))
    expect(headTierRank('explicit')).toBe(headTierRank('heavy'))
  })

  // Review bot #690 P2: never-downgrade was enforced only while routing ONE
  // turn, so two overlapping turns could land their writes out of order and let
  // a light decision replace a heavy pin. The rule lives in the WHERE clause now.
  /** The two AND-branches of the write predicate: may-write, and would-change. */
  const branches = () => (wheres[0].AND as Array<{ OR: Record<string, unknown>[] }>)

  it('refuses to overwrite a live HIGHER-ranked pin (atomic, in the where clause)', async () => {
    await rememberHeadPin(CONV, { modelId: 'or-deepseek-v4-flash', tier: 'light', via: 'routine_kw' })
    expect(wheres).toHaveLength(1)
    const allowedTiers = branches()[0].OR
      .map((c) => (c.pinnedHeadTier as { in?: string[] } | undefined)?.in)
      .find(Boolean)
    expect(allowedTiers).toEqual(['light'])
    expect(allowedTiers).not.toContain('heavy')
  })

  it('a heavy write may replace any live pin', async () => {
    await rememberHeadPin(CONV, { modelId: 'gpt-5.6-luna', tier: 'heavy', via: 'deny_kw' })
    const allowedTiers = branches()[0].OR
      .map((c) => (c.pinnedHeadTier as { in?: string[] } | undefined)?.in)
      .find(Boolean) as string[]
    expect(allowedTiers).toEqual(expect.arrayContaining(['light', 'marketing', 'heavy', 'explicit']))
  })

  // Review bot #690 P1: refreshing the expiry every turn meant a chat used all
  // day never dropped its heavy pin — one heavy question would own the routing
  // of everything after it. Re-stamping an identical live pin must match no row.
  it('does not slide the window by re-stamping an identical live pin', async () => {
    await rememberHeadPin(CONV, { modelId: 'gpt-5.6-luna', tier: 'heavy', via: 'task_pin' })
    const changed = branches()[1].OR
    expect(changed).toEqual(expect.arrayContaining([
      { pinnedHeadModel: { not: 'gpt-5.6-luna' } },
      { pinnedHeadTier: { not: 'heavy' } },
    ]))
  })

  // Found by reading a LIVE production conversation whose pin row was still
  // null after a heavy turn: SQL is three-valued, so `NOT (col = 'x' AND …)`
  // over NULL columns is UNKNOWN, and WHERE treats UNKNOWN as no match. The
  // predicate must therefore name the null case explicitly, in BOTH branches,
  // or a fresh conversation can never take its first pin.
  it('every branch names the NULL case, so a fresh conversation can be pinned', async () => {
    await rememberHeadPin(CONV, { modelId: 'gpt-5.6-luna', tier: 'heavy', via: 'triage' })
    expect(wheres[0].NOT).toBeUndefined()
    for (const branch of branches()) {
      expect(branch.OR).toEqual(expect.arrayContaining([{ pinnedHeadModel: null }]))
    }
  })

  it('exposes the clear patch the model picker applies in its own write', () => {
    expect(headPinClearFields()).toEqual({
      pinnedHeadModel: null,
      pinnedHeadTier: null,
      pinnedHeadVia: null,
      pinnedHeadUntil: null,
    })
  })
})
