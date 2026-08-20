import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PlanStep } from '@/agent/lib/planner'

const mockPrisma = {
  agentPlan: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  agentPlanStep: {
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  agentPendingAction: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  agentAskCard: {
    findUnique: vi.fn(),
  },
}
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

beforeEach(() => vi.clearAllMocks())

/** Fixture builder — every step carries the S0 retry fields. */
const step = (s: Partial<PlanStep> & { id: string; action: string }): PlanStep => ({
  dependsOn: [],
  status: 'pending',
  attemptCount: 0,
  maxAttempts: 3,
  ...s,
})

describe('planner', () => {
  it('preserves the primary approval owner and links deduplicated follower rows', async () => {
    const {
      linkPendingActionToPlanStep,
      linkedPlanStepIdFromPendingActionPayload,
      linkedPlanStepIdsFromPendingActionPayload,
    } = await import('@/agent/lib/planner')
    mockPrisma.agentPendingAction.findUnique.mockResolvedValueOnce({ payload: { amount: 5 } })
    mockPrisma.agentPendingAction.update.mockResolvedValueOnce({})
    await expect(linkPendingActionToPlanStep('action-1', 'step-1')).resolves.toBe(true)
    expect(mockPrisma.agentPendingAction.update).toHaveBeenCalledWith({
      where: { id: 'action-1' },
      data: {
        payload: {
          amount: 5,
          _agentPlanStepId: 'step-1',
          _agentPlanStepIds: ['step-1'],
        },
      },
    })
    expect(linkedPlanStepIdFromPendingActionPayload({ _agentPlanStepId: 'step-1' })).toBe('step-1')

    mockPrisma.agentPendingAction.findUnique.mockResolvedValueOnce({
      payload: { _agentPlanStepId: 'step-original' },
    })
    await expect(linkPendingActionToPlanStep('action-1', 'step-other')).resolves.toBe(true)
    expect(mockPrisma.agentPendingAction.update).toHaveBeenLastCalledWith({
      where: { id: 'action-1' },
      data: {
        payload: {
          _agentPlanStepId: 'step-original',
          _agentPlanStepIds: ['step-original', 'step-other'],
        },
      },
    })
    expect(linkedPlanStepIdsFromPendingActionPayload({
      _agentPlanStepId: 'step-original',
      _agentPlanStepIds: ['step-original', 'step-other', 'step-other'],
    })).toEqual(['step-original', 'step-other'])
  })

  it('completes the linked row only from a durable executed outcome', async () => {
    const { completePlanStepLinkedToPendingAction } = await import('@/agent/lib/planner')
    mockPrisma.agentPendingAction.findUnique.mockResolvedValueOnce({
      status: 'approved', type: 'publish', payload: { _agentPlanStepId: 'step-1' }, result: null,
    })
    await expect(completePlanStepLinkedToPendingAction('action-1')).resolves.toBeNull()
    expect(mockPrisma.agentPlanStep.updateMany).not.toHaveBeenCalled()

    mockPrisma.agentPendingAction.findUnique.mockResolvedValueOnce({
      status: 'executed', type: 'publish', payload: {
        _agentPlanStepId: 'step-1',
        _agentPlanStepIds: ['step-1', 'step-2'],
      }, result: { id: 'post-1' },
    })
    mockPrisma.agentPlanStep.findMany.mockResolvedValueOnce([
      { id: 'step-1', planId: 'plan-1', status: 'pending' },
      { id: 'step-2', planId: 'plan-2', status: 'running' },
    ])
    mockPrisma.agentPlanStep.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
    await expect(completePlanStepLinkedToPendingAction('action-1')).resolves.toBe('step-1')
    expect(mockPrisma.agentPlanStep.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'step-1', status: { in: ['pending', 'running'] } },
      data: expect.objectContaining({ status: 'done', turnId: null, dispatchedAt: null }),
    }))
    expect(mockPrisma.agentPlanStep.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'step-2', status: { in: ['pending', 'running'] } },
    }))
  })

  it('binds an ask card before display and completes only after its durable answer', async () => {
    const {
      ASK_CARD_PLAN_STEP_RESULT_KEY,
      completePlanStepsLinkedToAskCard,
      linkAskCardToPlanStep,
    } = await import('@/agent/lib/planner')
    mockPrisma.agentAskCard.findUnique.mockResolvedValueOnce({ id: 'ask-1' })
    mockPrisma.agentPlanStep.findUnique.mockResolvedValueOnce({ status: 'running', result: null })
    mockPrisma.agentPlanStep.updateMany.mockResolvedValueOnce({ count: 1 })
    await expect(linkAskCardToPlanStep('ask-1', 'step-1')).resolves.toBe(true)
    expect(mockPrisma.agentPlanStep.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'step-1', status: { in: ['pending', 'running'] } },
      data: { result: { [ASK_CARD_PLAN_STEP_RESULT_KEY]: 'ask-1' } },
    })

    mockPrisma.agentAskCard.findUnique.mockResolvedValueOnce({ status: 'pending', selectedOption: null })
    await expect(completePlanStepsLinkedToAskCard('ask-1')).resolves.toEqual([])

    mockPrisma.agentAskCard.findUnique.mockResolvedValueOnce({ status: 'answered', selectedOption: 'হ্যাঁ' })
    mockPrisma.agentPlanStep.findMany.mockResolvedValueOnce([{ id: 'step-1', planId: 'plan-1' }])
    mockPrisma.agentPlanStep.updateMany.mockResolvedValueOnce({ count: 1 })
    await expect(completePlanStepsLinkedToAskCard('ask-1')).resolves.toEqual(['step-1'])
    expect(mockPrisma.agentPlanStep.findMany).toHaveBeenLastCalledWith({
      where: {
        status: { in: ['pending', 'running'] },
        result: { path: [ASK_CARD_PLAN_STEP_RESULT_KEY], equals: 'ask-1' },
      },
      select: { id: true, planId: true },
    })
    expect(mockPrisma.agentPlanStep.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'step-1', status: { in: ['pending', 'running'] } },
      data: expect.objectContaining({
        status: 'done',
        result: expect.objectContaining({ selectedOption: 'হ্যাঁ' }),
      }),
    }))
  })

  it('createPlan persists goal and steps with correct sequence', async () => {
    const { createPlan } = await import('@/agent/lib/planner')

    const fakePlan = {
      id: 'plan-1',
      goal: 'Eid campaign setup',
      status: 'draft',
      selfCheckNote: null,
      steps: [
        { id: 's1', seq: 1, action: 'Research competitors', toolName: null, dependsOn: [], status: 'pending', result: null, error: null },
        { id: 's2', seq: 2, action: 'Create ad creative', toolName: 'make_ad_creatives', dependsOn: [], status: 'pending', result: null, error: null },
        { id: 's3', seq: 3, action: 'Set budget', toolName: 'update_campaign_budget', dependsOn: [], status: 'pending', result: null, error: null },
      ],
    }
    mockPrisma.agentPlan.create.mockResolvedValue(fakePlan)

    const result = await createPlan({
      goal: 'Eid campaign setup',
      steps: [
        { action: 'Research competitors' },
        { action: 'Create ad creative', toolName: 'make_ad_creatives', dependsOn: ['s1'] },
        { action: 'Set budget', toolName: 'update_campaign_budget', dependsOn: ['s2'] },
      ],
    })

    expect(result.id).toBe('plan-1')
    expect(result.goal).toBe('Eid campaign setup')
    expect(result.steps).toHaveLength(3)
    expect(result.status).toBe('draft')
    expect(mockPrisma.agentPlan.create).toHaveBeenCalledOnce()
  })

  // ── S0: dependency resolution ────────────────────────────────────────────
  // Authors write "step-1"; getReadySteps compares against DB uuids. Until this
  // fix EVERY ordered plan was structurally dead — no dependency could resolve.
  it('resolveDependsOn maps logical step keys onto real DB ids', async () => {
    const { resolveDependsOn } = await import('@/agent/lib/planner')
    const ids = ['db-a', 'db-b', 'db-c']

    expect(resolveDependsOn(['step-1'], ids)).toEqual(['db-a'])
    expect(resolveDependsOn(['step-2', 'step-3'], ids)).toEqual(['db-b', 'db-c'])
    // Already-real ids pass through; duplicates collapse.
    expect(resolveDependsOn(['db-b', 'step-2'], ids)).toEqual(['db-b'])
    // Unresolvable keys are dropped — keeping them would freeze the plan forever.
    expect(resolveDependsOn(['step-9', 'nonsense'], ids)).toEqual([])
  })

  it('createPlan writes resolved DB ids back onto the steps', async () => {
    const { createPlan } = await import('@/agent/lib/planner')
    mockPrisma.agentPlan.create.mockResolvedValue({
      id: 'plan-2',
      goal: 'diagnose then fix',
      status: 'draft',
      steps: [
        { id: 'uuid-1', seq: 1, action: 'diagnose', toolName: null, dependsOn: [], status: 'pending' },
        { id: 'uuid-2', seq: 2, action: 'fix', toolName: null, dependsOn: [], status: 'pending' },
      ],
    })

    const plan = await createPlan({
      goal: 'diagnose then fix',
      steps: [{ action: 'diagnose' }, { action: 'fix', dependsOn: ['step-1'] }],
    })

    expect(plan.steps[1].dependsOn).toEqual(['uuid-1'])
    expect(mockPrisma.agentPlanStep.update).toHaveBeenCalledWith({
      where: { id: 'uuid-2' },
      data: { dependsOn: ['uuid-1'] },
    })
  })

  it('getReadySteps returns only steps with all deps done', async () => {
    const { getReadySteps } = await import('@/agent/lib/planner')

    const plan = {
      steps: [
        step({ id: 's1', action: 'Step 1', status: 'done' }),
        step({ id: 's2', action: 'Step 2', dependsOn: ['s1'] }),
        step({ id: 's3', action: 'Step 3', dependsOn: ['s1', 's2'] }),
        step({ id: 's4', action: 'Step 4' }),
      ],
    }

    expect(getReadySteps(plan).map(s => s.id)).toEqual(['s2', 's4'])
  })

  it('getReadySteps blocks step when dependency not done', async () => {
    const { getReadySteps } = await import('@/agent/lib/planner')

    const plan = {
      steps: [
        step({ id: 's1', action: 'Step 1' }),
        step({ id: 's2', action: 'Step 2', dependsOn: ['s1'] }),
      ],
    }

    expect(getReadySteps(plan).map(s => s.id)).toEqual(['s1'])
  })

  // ── S0: a failed step retries instead of killing the plan ────────────────
  it('getReadySteps re-queues a failed step once its retry window has passed', async () => {
    const { getReadySteps } = await import('@/agent/lib/planner')
    const now = new Date('2026-07-25T10:00:00Z')

    const plan = {
      steps: [
        step({
          id: 's1', action: 'flaky', status: 'failed', attemptCount: 1, maxAttempts: 3,
          nextAttemptAt: new Date('2026-07-25T09:59:00Z'),
        }),
        step({
          id: 's2', action: 'still cooling off', status: 'failed', attemptCount: 1, maxAttempts: 3,
          nextAttemptAt: new Date('2026-07-25T10:05:00Z'),
        }),
        step({ id: 's3', action: 'exhausted', status: 'failed', attemptCount: 3, maxAttempts: 3 }),
      ],
    }

    expect(getReadySteps(plan, now).map(s => s.id)).toEqual(['s1'])
  })

  it('hasExhaustedStep only fires when a step is out of retries', async () => {
    const { hasExhaustedStep } = await import('@/agent/lib/planner')

    expect(hasExhaustedStep({
      steps: [step({ id: 's1', action: 'x', status: 'failed', attemptCount: 1, maxAttempts: 3 })],
    })).toBe(false)

    expect(hasExhaustedStep({
      steps: [step({ id: 's1', action: 'x', status: 'failed', attemptCount: 3, maxAttempts: 3 })],
    })).toBe(true)
  })

  it('stepRetryDelayMs grows with each attempt and stays bounded', async () => {
    const { stepRetryDelayMs } = await import('@/agent/lib/planner')
    expect(stepRetryDelayMs(1)).toBe(2 * 60_000)
    expect(stepRetryDelayMs(2)).toBe(8 * 60_000)
    expect(stepRetryDelayMs(99)).toBe(60 * 60_000)
  })

  it('getDispatchedSteps finds steps waiting on a worker turn', async () => {
    const { getDispatchedSteps } = await import('@/agent/lib/planner')
    const plan = {
      steps: [
        step({ id: 's1', action: 'queued', status: 'running', turnId: 'turn-1' }),
        step({ id: 's2', action: 'inline', status: 'running' }),
        step({ id: 's3', action: 'idle' }),
      ],
    }
    expect(getDispatchedSteps(plan).map(s => s.id)).toEqual(['s1'])
  })

  it('dhakaDayKey rolls over at Dhaka midnight, not UTC midnight', async () => {
    const { dhakaDayKey } = await import('@/agent/lib/planner')
    // 19:00 UTC on the 24th is already 01:00 on the 25th in Dhaka (UTC+6).
    expect(dhakaDayKey(new Date('2026-07-24T19:00:00Z'))).toBe('2026-07-25')
    expect(dhakaDayKey(new Date('2026-07-24T17:00:00Z'))).toBe('2026-07-24')
  })

  it('selfCheck reports failures correctly', async () => {
    const { selfCheck } = await import('@/agent/lib/planner')

    const plan = {
      steps: [
        step({ id: 's1', action: 'Step 1', status: 'done' }),
        step({ id: 's2', action: 'Step 2 (failed)', dependsOn: ['s1'], status: 'failed', error: 'API error' }),
        step({ id: 's3', action: 'Step 3', dependsOn: ['s2'] }),
      ],
    }

    const check = selfCheck(plan)
    expect(check.allDone).toBe(false)
    expect(check.completedCount).toBe(1)
    expect(check.failedSteps).toContain('Step 2 (failed)')
    expect(check.pendingSteps).toContain('Step 3')
  })

  it('selfCheck reports all-done when no failures or pending', async () => {
    const { selfCheck } = await import('@/agent/lib/planner')

    const plan = {
      steps: [
        step({ id: 's1', action: 'Step 1', status: 'done' }),
        step({ id: 's2', action: 'Step 2', dependsOn: ['s1'], status: 'done' }),
      ],
    }

    const check = selfCheck(plan)
    expect(check.allDone).toBe(true)
    expect(check.completedCount).toBe(2)
  })

  it('countRepairSteps counts only auto-repair steps', async () => {
    const { countRepairSteps, AUTOREPAIR_TOOL } = await import('@/agent/lib/planner')

    const plan = {
      steps: [
        step({ id: 's1', action: 'Original', status: 'done' }),
        step({ id: 's2', action: 'সংশোধন: x', toolName: AUTOREPAIR_TOOL, status: 'done' }),
        step({ id: 's3', action: 'সংশোধন: y', toolName: AUTOREPAIR_TOOL }),
      ],
    }

    expect(countRepairSteps(plan)).toBe(2)
  })

  it('countRepairSteps returns 0 when no corrective steps', async () => {
    const { countRepairSteps } = await import('@/agent/lib/planner')

    const plan = {
      steps: [
        step({ id: 's1', action: 'A', toolName: 'make_ad_creatives', status: 'done' }),
        step({ id: 's2', action: 'B' }),
      ],
    }

    expect(countRepairSteps(plan)).toBe(0)
  })

  it('hasFailed returns true when any step failed', async () => {
    const { hasFailed } = await import('@/agent/lib/planner')

    const plan = {
      steps: [
        step({ id: 's1', action: 'OK', status: 'done' }),
        step({ id: 's2', action: 'Bad', status: 'failed' }),
      ],
    }

    expect(hasFailed(plan)).toBe(true)
  })

  // ── S0: markStepFailed records the attempt and schedules the retry ───────
  it('markStepFailed counts the attempt and schedules a retry window', async () => {
    const { markStepFailed } = await import('@/agent/lib/planner')
    mockPrisma.agentPlanStep.findUnique.mockResolvedValue({ attemptCount: 0, maxAttempts: 3 })
    const now = new Date('2026-07-25T10:00:00Z')

    await markStepFailed('s1', 'boom', now)

    const data = mockPrisma.agentPlanStep.update.mock.calls[0][0].data
    expect(data.status).toBe('failed')
    expect(data.attemptCount).toBe(1)
    expect(data.nextAttemptAt).toEqual(new Date('2026-07-25T10:02:00Z'))
  })

  it('markStepFailed stops scheduling once the step is out of retries', async () => {
    const { markStepFailed } = await import('@/agent/lib/planner')
    mockPrisma.agentPlanStep.findUnique.mockResolvedValue({ attemptCount: 2, maxAttempts: 3 })

    await markStepFailed('s1', 'boom', new Date('2026-07-25T10:00:00Z'))

    const data = mockPrisma.agentPlanStep.update.mock.calls[0][0].data
    expect(data.attemptCount).toBe(3)
    expect(data.nextAttemptAt).toBeNull()
  })

  // ── S0: approval no longer deadlocks the plan ────────────────────────────
  it('markStepBlocked returns the step to pending so approval can resume it', async () => {
    const { markStepBlocked } = await import('@/agent/lib/planner')

    await markStepBlocked('s1')

    expect(mockPrisma.agentPlanStep.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { status: 'pending', turnId: null, dispatchedAt: null, nextAttemptAt: null },
      select: { planId: true },
    })
  })
})
