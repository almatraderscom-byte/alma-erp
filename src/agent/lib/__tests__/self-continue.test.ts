/**
 * The agent's own wake-up (owner ruling 2026-07-26).
 *
 * "এজেন্ট ১৩ মিনিট কাজ করার পর যদি কাজ শেষ না হয় … নিজে থেকে একটা wakeup সেট
 * করবে … এভাবে কন্টিনিউ করে শেষ করবে। এখানে Plan-Drive-এর কোনো কাজ নেই।"
 *
 * Two things used to stop that: continuation only fired for BROWSER turns, and
 * the resume was a hint to the client (so it needed his app open).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentKvSetting: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const continuation = vi.hoisted(() => ({
  enqueueAgentContinuation: vi.fn().mockResolvedValue({
    outcome: 'queued', turnId: 'next-turn', requestId: 'self-request', status: 'running',
  }),
}))
vi.mock('@/agent/lib/approval-continuation', () => continuation)

const sourceBinding = vi.hoisted(() => ({
  buildSelfContinueBinding: vi.fn(),
}))
vi.mock('@/agent/lib/continuation-binding', () => sourceBinding)

import { shouldAutoContinueTurn, mayContinueChain, MAX_SELF_CONTINUE_HOPS } from '@/agent/lib/continuation-policy'
import {
  scheduleSelfContinue,
  clearHops,
  haltSelfContinueChain,
  resetSelfContinueChain,
  isEngineDirectiveText,
  MAX_CONSECUTIVE_DRY_HOPS,
} from '@/agent/lib/self-continue'

/** Per-key KV store backing findUnique/upsert, for the brake tests. */
function useKvStore(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  mockPrisma.agentKvSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) =>
    store.has(where.key) ? { key: where.key, value: store.get(where.key) } : null)
  mockPrisma.agentKvSetting.upsert.mockImplementation(async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
    store.set(where.key, create.value)
    return {}
  })
  mockPrisma.agentKvSetting.deleteMany.mockImplementation(async ({ where }: { where: { key: { in: string[] } } }) => {
    for (const key of where.key.in) store.delete(key)
    return { count: 0 }
  })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentKvSetting.findUnique.mockResolvedValue(null)
  mockPrisma.agentKvSetting.upsert.mockResolvedValue({})
  mockPrisma.agentKvSetting.deleteMany.mockResolvedValue({ count: 0 })
  continuation.enqueueAgentContinuation.mockResolvedValue({
    outcome: 'queued', turnId: 'next-turn', requestId: 'self-request', status: 'running',
  })
  sourceBinding.buildSelfContinueBinding.mockResolvedValue({
    v: 1,
    origin: 'self_continue',
    source: { kind: 'turn', id: 'source-turn-1' },
    conversationId: 'c1',
    domain: 'seo',
    event: 'deadline_resume',
    workflowRunId: 'workflow-seo-1',
    authorityRef: {
      kind: 'source_binding',
      id: 'continuation:v1:job_result:pending_action:action-seo:artifact_delivered',
    },
    directive: { kind: 'deadline_resume', version: 1 },
    expected: { sourceStatus: ['running', 'done'] },
  })
})

describe('when a deadline-hit turn should carry itself on', () => {
  const tools = (names: string[]) => names.map((toolName) => ({ toolName, status: 'success' as const }))

  it('resumes ANY unfinished tool work, not just browser work', () => {
    // The exact case that used to stop dead: a long SEO/tool job.
    expect(shouldAutoContinueTurn({
      deadlineHit: true, hasAskCard: false,
      tools: tools(['run_website_seo_audit', 'check_website_seo_audit']),
    })).toBe(true)
  })

  it('still resumes browser work', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true, hasAskCard: false, tools: tools(['live_browser_click']),
    })).toBe(true)
  })

  it('does not resume when Boss has an open question', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true, hasAskCard: true, tools: tools(['get_orders']),
    })).toBe(false)
  })

  it('does not resume a turn that never hit the deadline', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: false, hasAskCard: false, tools: tools(['get_orders']),
    })).toBe(false)
  })

  it('does not resume once terminal proof landed', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true, hasAskCard: false, tools: tools(['complete_skill_pack_run']),
    })).toBe(false)
  })

  it('does not resume a turn that achieved nothing', () => {
    expect(shouldAutoContinueTurn({
      deadlineHit: true, hasAskCard: false,
      tools: [{ toolName: 'get_orders', status: 'error' as const }],
    })).toBe(false)
  })
})

describe('the wake-up chain', () => {
  it('schedules the next hop on the server, so his app need not be open', async () => {
    const res = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1',
    })

    expect(res.scheduled).toBe(true)
    expect(res.hops).toBe(1)
    const call = continuation.enqueueAgentContinuation.mock.calls[0][0]
    expect(call.conversationId).toBe('c1')
    expect(call.force).toBe(true)               // not subject to the auto-continue toggle
    expect(call.message).toBeUndefined()
    expect(sourceBinding.buildSelfContinueBinding).toHaveBeenCalledWith({
      conversationId: 'c1', sourceTurnId: 'source-turn-1',
    })
    expect(call.binding).toEqual({
      v: 1,
      origin: 'self_continue',
      source: { kind: 'turn', id: 'source-turn-1' },
      conversationId: 'c1',
      domain: 'seo',
      event: 'deadline_resume',
      workflowRunId: 'workflow-seo-1',
      authorityRef: {
        kind: 'source_binding',
        id: 'continuation:v1:job_result:pending_action:action-seo:artifact_delivered',
      },
      directive: { kind: 'deadline_resume', version: 1 },
      expected: { sourceStatus: ['running', 'done'] },
    })
  })

  it('counts hops so a confused task cannot run all night', () => {
    expect(mayContinueChain(0)).toBe(true)
    expect(mayContinueChain(MAX_SELF_CONTINUE_HOPS - 1)).toBe(true)
    expect(mayContinueChain(MAX_SELF_CONTINUE_HOPS)).toBe(false)
  })

  it('stops scheduling at the hop limit and says why', async () => {
    mockPrisma.agentKvSetting.findUnique.mockResolvedValue({ value: String(MAX_SELF_CONTINUE_HOPS) })

    const res = await scheduleSelfContinue({ conversationId: 'c1', sourceTurnId: 'source-turn-1' })

    expect(res.scheduled).toBe(false)
    expect(res.reason).toContain('hop limit')
    expect(continuation.enqueueAgentContinuation).not.toHaveBeenCalled()
  })

  it('fails visibly without an exact predecessor turn instead of using the summary as authority', async () => {
    const res = await scheduleSelfContinue({ conversationId: 'c1', sourceTurnId: '' })

    expect(res).toEqual({ scheduled: false, hops: 0, reason: 'source turn missing' })
    expect(continuation.enqueueAgentContinuation).not.toHaveBeenCalled()
    expect(sourceBinding.buildSelfContinueBinding).not.toHaveBeenCalled()
    expect(mockPrisma.agentKvSetting.upsert).not.toHaveBeenCalled()
  })

  it('never runs the 90s inline fallback from inside a deadline turn (Codex P1 #850)', async () => {
    const res = await scheduleSelfContinue({ conversationId: 'c1', sourceTurnId: 'source-turn-1' })

    expect(res.scheduled).toBe(true)
    const call = continuation.enqueueAgentContinuation.mock.calls[0][0]
    // hasSafeInlineContinuationBudget(now) is false at a zero-remaining
    // deadline, so a worker-down enqueue defers instead of executing inline.
    expect(typeof call.inlineDeadlineAtMs).toBe('number')
    expect(call.inlineDeadlineAtMs).toBeLessThanOrEqual(Date.now())
  })

  it('a worker-down deferral is reported honestly, never as a scheduled wake', async () => {
    continuation.enqueueAgentContinuation.mockResolvedValue({
      outcome: 'deferred', turnId: 'next-turn', requestId: 'self-request', status: 'running',
    })

    const res = await scheduleSelfContinue({ conversationId: 'c1', sourceTurnId: 'source-turn-1' })

    expect(res.scheduled).toBe(false)
    expect(res.reason).toBe('worker_unavailable_deferred_to_owner')
  })

  it('does not claim a wake was scheduled when bound enqueue is rejected', async () => {
    continuation.enqueueAgentContinuation.mockResolvedValue({
      outcome: 'rejected', turnId: null, requestId: null, status: 'binding_required',
    })

    const res = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1',
    })

    expect(res).toMatchObject({ scheduled: false, hops: 1, reason: 'binding_required' })
  })

  it('stops after two consecutive dry hops instead of burning more (runaway 2026-08-24)', async () => {
    const store = useKvStore()

    // Hop 1: dry (zero new successful tool results) — still allowed.
    const first = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1',
      progress: { successfulToolResults: 0 },
    })
    expect(first.scheduled).toBe(true)
    expect(store.get('self_continue_dry:c1')).toBe('1')

    // Hop 2: dry again — the brake fires, nothing is enqueued, the stop reason persists.
    continuation.enqueueAgentContinuation.mockClear()
    const second = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1',
      progress: { successfulToolResults: 0 },
    })
    expect(second.scheduled).toBe(false)
    expect(second.stop).toBe('no_progress')
    expect(continuation.enqueueAgentContinuation).not.toHaveBeenCalled()
    expect(JSON.parse(store.get('self_continue_stop:c1')!)).toMatchObject({ reason: 'no_progress' })
    expect(MAX_CONSECUTIVE_DRY_HOPS).toBe(2)
  })

  it('repeated fingerprints are DRY even though the calls succeeded (Codex P1 #850 r4)', async () => {
    const store = useKvStore()
    const repeat = { successfulToolFingerprints: ['get_inventory_status:abc123'] }

    // Hop 1 introduces the fingerprint — new work.
    const first = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1', progress: repeat,
    })
    expect(first.scheduled).toBe(true)
    expect(store.get('self_continue_dry:c1')).toBe('0')

    // Hops 2 and 3 only repeat the same successful read — dry, then braked.
    const second = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1', progress: repeat,
    })
    expect(second.scheduled).toBe(true)
    expect(store.get('self_continue_dry:c1')).toBe('1')

    continuation.enqueueAgentContinuation.mockClear()
    const third = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1', progress: repeat,
    })
    expect(third.scheduled).toBe(false)
    expect(third.stop).toBe('no_progress')
    expect(continuation.enqueueAgentContinuation).not.toHaveBeenCalled()
  })

  it('a genuinely new fingerprint resets the dry counter', async () => {
    const store = useKvStore({
      'self_continue_dry:c1': '1',
      'self_continue_seen:c1': JSON.stringify(['get_inventory_status:abc123']),
    })

    const res = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1',
      progress: { successfulToolFingerprints: ['get_reorder_suggestions:def456'] },
    })

    expect(res.scheduled).toBe(true)
    expect(store.get('self_continue_dry:c1')).toBe('0')
    expect(JSON.parse(store.get('self_continue_seen:c1')!)).toContain('get_reorder_suggestions:def456')
  })

  it('real progress resets the dry counter', async () => {
    const store = useKvStore({ 'self_continue_dry:c1': '1' })

    const res = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1',
      progress: { successfulToolResults: 3 },
    })

    expect(res.scheduled).toBe(true)
    expect(store.get('self_continue_dry:c1')).toBe('0')
  })

  it('a halted chain (authority guard) refuses every further hop until the owner resets it', async () => {
    const store = useKvStore()

    await haltSelfContinueChain('c1', 'owner-input binding guard blocked the hop')
    const blocked = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1',
      progress: { successfulToolResults: 5 },
    })
    expect(blocked.scheduled).toBe(false)
    expect(blocked.stop).toBe('authority_blocked')
    expect(continuation.enqueueAgentContinuation).not.toHaveBeenCalled()

    // A genuine owner message renews the budget.
    await resetSelfContinueChain('c1')
    expect(store.has('self_continue_stop:c1')).toBe(false)
    const resumed = await scheduleSelfContinue({
      conversationId: 'c1', sourceTurnId: 'source-turn-1',
      progress: { successfulToolResults: 5 },
    })
    expect(resumed.scheduled).toBe(true)
  })

  it('persists the hop-limit stop reason durably for the tracker', async () => {
    const store = useKvStore({ 'self_continue_hops:c1': String(MAX_SELF_CONTINUE_HOPS) })

    const res = await scheduleSelfContinue({ conversationId: 'c1', sourceTurnId: 'source-turn-1' })

    expect(res.scheduled).toBe(false)
    expect(res.stop).toBe('hop_limit')
    expect(JSON.parse(store.get('self_continue_stop:c1')!)).toMatchObject({
      reason: 'hop_limit',
      hops: MAX_SELF_CONTINUE_HOPS,
    })
  })

  it('engine directives never count as the owner speaking', () => {
    expect(isEngineDirectiveText('[স্বয়ংক্রিয় হার্টবিট — তুমি নিজে থেকে জেগেছ]')).toBe(true)
    expect(isEngineDirectiveText('[SELF-CONTINUE hop 3]')).toBe(true)
    expect(isEngineDirectiveText('আজকের inventory-র রিপোর্ট দাও')).toBe(false)
    expect(isEngineDirectiveText('continue')).toBe(false)
  })

  it('clears an already-absent hop counter without a record-not-found error', async () => {
    await clearHops('c1')
    await clearHops('c1')

    expect(mockPrisma.agentKvSetting.deleteMany).toHaveBeenCalledTimes(2)
    expect(mockPrisma.agentKvSetting.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { key: { in: ['self_continue_hops:c1', 'self_continue_dry:c1', 'self_continue_stop:c1', 'self_continue_seen:c1'] } },
    })
  })
})
