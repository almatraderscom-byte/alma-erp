/**
 * Runaway 2026-08-24: a plan step whose worker turn was refused by a server
 * execution guard (owner-input / continuation binding) still ended with turn
 * status 'done', so reap marked the step DONE with the blocker text as its
 * "result" — the plan marched on and re-hit the same wall every hop. A
 * guard-blocked turn is a FAILED step whose detail surfaces the blocker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  agentTurn: { findUnique: vi.fn() },
  agentMessage: { findUnique: vi.fn(), findFirst: vi.fn() },
  agentPendingAction: { count: vi.fn(async () => 0) },
  agentAskCard: { count: vi.fn(async () => 0) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

const planner = vi.hoisted(() => ({
  getDispatchedSteps: vi.fn(),
  markStepDone: vi.fn(async () => {}),
  markStepFailed: vi.fn(async () => {}),
  markStepBlocked: vi.fn(async () => {}),
}))
vi.mock('@/agent/lib/planner', () => planner)

import { reapPlan, isServerGuardBlockedMessage } from '@/agent/lib/plan-driver/reap'

const step = {
  id: 'step-1',
  action: 'inventory report চালাও',
  status: 'dispatched',
  turnId: 'turn-1',
  dispatchedAt: new Date('2026-08-24T00:00:00Z'),
}
const plan = { id: 'plan-1', conversationId: 'conv-1', steps: [step] }

beforeEach(() => {
  vi.clearAllMocks()
  planner.getDispatchedSteps.mockReturnValue([step])
  prismaMock.agentPendingAction.count.mockResolvedValue(0)
  prismaMock.agentAskCard.count.mockResolvedValue(0)
  prismaMock.agentTurn.findUnique.mockResolvedValue({
    status: 'done',
    assistantMessageId: 'msg-1',
    conversationId: 'conv-1',
    startedAt: new Date('2026-08-24T00:00:00Z'),
  })
})

describe('reap vs server guard blockers', () => {
  it('recognizes guard-stamped usage', () => {
    expect(isServerGuardBlockedMessage({ model: 'server-owner-input-binding-guard' })).toBe(true)
    expect(isServerGuardBlockedMessage({ model: 'server-continuation-binding-guard' })).toBe(true)
    expect(isServerGuardBlockedMessage({ model: 'server-direct-youtube-route-guard' })).toBe(true)
    expect(isServerGuardBlockedMessage({ model: 'gpt-5.6-luna' })).toBe(false)
    expect(isServerGuardBlockedMessage(null)).toBe(false)
    expect(isServerGuardBlockedMessage('server-x-guard')).toBe(false)
  })

  it('a guard-blocked "done" turn FAILS the step with the blocker as the detail — never done', async () => {
    prismaMock.agentMessage.findUnique.mockResolvedValue({
      content: [{ type: 'text', text: '⚠️ এই turn-এর owner request bind করা যায়নি।' }],
      costUsd: 0,
      usage: { model: 'server-owner-input-binding-guard', provider: 'server' },
    })

    const out = await reapPlan(plan as never)

    expect(out).toHaveLength(1)
    expect(out[0].outcome).toBe('failed')
    expect(out[0].detail).toContain('execution guard blocked the step')
    expect(planner.markStepFailed).toHaveBeenCalledWith('step-1', expect.stringContaining('guard'), expect.any(Date))
    expect(planner.markStepDone).not.toHaveBeenCalled()
  })

  it('a genuinely done turn still books the step done', async () => {
    prismaMock.agentMessage.findUnique.mockResolvedValue({
      content: [{ type: 'text', text: 'রিপোর্ট তৈরি হয়েছে।' }],
      costUsd: 0.12,
      usage: { model: 'gpt-5.6-luna', provider: 'openai' },
    })

    const out = await reapPlan(plan as never)

    expect(out[0].outcome).toBe('done')
    expect(planner.markStepDone).toHaveBeenCalled()
    expect(planner.markStepFailed).not.toHaveBeenCalled()
  })
})
