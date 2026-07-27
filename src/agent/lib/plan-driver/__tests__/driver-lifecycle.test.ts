/**
 * Plan-Driver lifecycle (S0). Each test pins one defect that made the engine
 * unable to finish anything, so a regression here is loud.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Plan, PlanStep } from '@/agent/lib/planner'

const mockPrisma = vi.hoisted(() => ({
  agentPendingAction: { count: vi.fn().mockResolvedValue(0) },
  agentAskCard: { count: vi.fn().mockResolvedValue(0) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

const planner = vi.hoisted(() => ({
  markStepRunning: vi.fn(),
  markStepDone: vi.fn(),
  markStepFailed: vi.fn(),
  markStepBlocked: vi.fn(),
  markStepDispatched: vi.fn(),
  updatePlanStatus: vi.fn(),
  setAutodriveState: vi.fn(),
  recordDriveTick: vi.fn(),
  appendCorrectiveStep: vi.fn(),
  loadPlan: vi.fn(),
}))
vi.mock('@/agent/lib/planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/lib/planner')>()
  return { ...actual, ...planner }
})

const exec = vi.hoisted(() => ({ executeStep: vi.fn() }))
vi.mock('@/agent/lib/plan-driver/executor', () => exec)

const reap = vi.hoisted(() => ({ reapPlan: vi.fn() }))
vi.mock('@/agent/lib/plan-driver/reap', () => reap)

const gate = vi.hoisted(() => ({ runCompletionGate: vi.fn() }))
vi.mock('@/agent/lib/plan-driver/completion-gate', () => gate)

// Grind hooks are exercised by their own tests; here they are inert so these
// cases pin the PLAIN plan lifecycle.
const grind = vi.hoisted(() => ({
  preflightGrindStep: vi.fn().mockResolvedValue({ allow: true }),
  afterGrindStep: vi.fn().mockResolvedValue(null),
  grindCompletionForPlan: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/agent/lib/grind/driver-hooks', () => grind)

vi.mock('@/agent/lib/plan-driver/promote', () => ({
  completeSourceTodoForPlan: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/agent/lib/notify-owner', () => ({ notifyOwnerIfAway: vi.fn().mockResolvedValue({ skipped: true }) }))
vi.mock('@/agent/lib/checkpoint', () => ({ writeCheckpoint: vi.fn() }))
vi.mock('@/agent/lib/autodrive-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/lib/autodrive-config')>()
  return { ...actual, getPlanCapOverrideTaka: vi.fn().mockResolvedValue(0) }
})

import { drivePlan } from '@/agent/lib/plan-driver/driver'
import type { AutodriveConfig } from '@/agent/lib/autodrive-config'

const config: AutodriveConfig = {
  enabled: true,
  dailyCapTaka: 200,
  planCapTaka: 50,
  maxAttempts: 5,
  batchSize: 10,
  gateModel: 'gate',
  driverModel: 'or-deepseek-v4-flash',
  backoffMin: 3,
  autoRepair: false,
  maxRepairSteps: 2,
}

const step = (s: Partial<PlanStep> & { id: string; action: string }): PlanStep => ({
  dependsOn: [],
  status: 'pending',
  attemptCount: 0,
  maxAttempts: 3,
  ...s,
})

const plan = (over: Partial<Plan> = {}): Plan => ({
  id: 'p1',
  goal: 'ঠিক করো',
  status: 'executing',
  conversationId: 'conv-1',
  businessId: 'ALMA_LIFESTYLE',
  steps: [step({ id: 's1', action: 'কাজ ১' })],
  autodriveState: 'driving',
  attemptCount: 0,
  maxAttempts: 5,
  costTaka: 0,
  costMilliTaka: 0,
  costMilliTakaDay: 0,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.agentPendingAction.count.mockResolvedValue(0)
  mockPrisma.agentAskCard.count.mockResolvedValue(0)
  reap.reapPlan.mockResolvedValue([])
})

describe('drivePlan — S0 lifecycle', () => {
  it('dispatches a step to the worker queue and parks without running it inline', async () => {
    exec.executeStep.mockResolvedValue({ ok: false, summary: '', costUsd: 0, blocked: false, dispatched: true, turnId: 't-1' })

    const res = await drivePlan(plan(), config)

    expect(res.outcome).toBe('step-dispatched')
    expect(planner.markStepDispatched).toHaveBeenCalledWith('s1', 't-1', expect.any(Date))
    expect(planner.markStepDone).not.toHaveBeenCalled()
  })

  it('an approval sends the step back to PENDING, so approving it can resume the plan', async () => {
    // The old code left the step 'running'; getReadySteps can never pick that up,
    // so approving the card deadlocked the very plan it was meant to unblock.
    exec.executeStep.mockResolvedValue({ ok: false, summary: '', costUsd: 0, blocked: true, pendingActionId: 'pa-1' })

    const res = await drivePlan(plan(), config)

    expect(res.outcome).toBe('blocked-approval')
    expect(planner.markStepBlocked).toHaveBeenCalledWith('s1')
    expect(planner.setAutodriveState).toHaveBeenCalledWith('p1', 'blocked', expect.anything())
  })

  it('waits (does not escalate) while a failed step is still inside its retry window', async () => {
    const soon = new Date(Date.now() + 5 * 60_000)
    const res = await drivePlan(
      plan({ steps: [step({ id: 's1', action: 'flaky', status: 'failed', attemptCount: 1, nextAttemptAt: soon })] }),
      config,
    )

    expect(res.outcome).toBe('waiting-retry')
    expect(planner.setAutodriveState).toHaveBeenCalledWith('p1', 'driving', { nextTickAt: soon })
  })

  it('escalates only once a step has exhausted its own retries', async () => {
    const res = await drivePlan(
      plan({ steps: [step({ id: 's1', action: 'broken', status: 'failed', attemptCount: 3, maxAttempts: 3 })] }),
      config,
    )

    expect(res.outcome).toBe('escalated-stuck')
  })

  it('books a reaped step and then keeps driving the plan', async () => {
    reap.reapPlan.mockResolvedValue([{ stepId: 's1', outcome: 'done', detail: 'কাজ ১', costUsd: 0.002 }])
    planner.loadPlan.mockResolvedValue(plan({ steps: [step({ id: 's1', action: 'কাজ ১', status: 'done' })] }))
    gate.runCompletionGate.mockResolvedValue({ done: true, reason: 'সব হয়েছে', costUsd: 0 })

    const res = await drivePlan(
      plan({ steps: [step({ id: 's1', action: 'কাজ ১', status: 'running', turnId: 't-1' })] }),
      config,
    )

    expect(res.outcome).toBe('plan-done')
    // 0.002 USD ≈ 0.25৳ → 250 milli-taka, NOT the 1৳ the old rounding charged.
    expect(planner.recordDriveTick).toHaveBeenCalledWith('p1', expect.objectContaining({ addCostMilliTaka: 250 }))
  })

  it('leaves a still-running worker turn alone instead of starting a second step', async () => {
    reap.reapPlan.mockResolvedValue([{ stepId: 's1', outcome: 'waiting', detail: 'worker still running', costUsd: 0 }])

    const res = await drivePlan(
      plan({ steps: [step({ id: 's1', action: 'কাজ ১', status: 'running', turnId: 't-1' })] }),
      config,
    )

    expect(res.outcome).toBe('waiting-dispatch')
    expect(exec.executeStep).not.toHaveBeenCalled()
  })

  it('counts an unanswered ASK card as an open approval, not just a confirm card', async () => {
    mockPrisma.agentAskCard.count.mockResolvedValue(1)

    const res = await drivePlan(plan({ autodriveState: 'blocked' }), config)

    expect(res.outcome).toBe('waiting-approval')
    expect(exec.executeStep).not.toHaveBeenCalled()
  })

  it('escalates on the plan cost cap using milli-taka, not rounded taka', async () => {
    const res = await drivePlan(plan({ costMilliTaka: 50_000 }), config) // exactly 50৳
    expect(res.outcome).toBe('escalated-cap')

    vi.clearAllMocks()
    reap.reapPlan.mockResolvedValue([])
    exec.executeStep.mockResolvedValue({ ok: true, summary: 'হয়েছে', costUsd: 0, blocked: false })
    const under = await drivePlan(plan({ costMilliTaka: 49_999 }), config) // 49.999৳
    expect(under.outcome).toBe('step-done')
  })
})
