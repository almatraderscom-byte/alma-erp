import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = {
  agentPlan: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  agentPlanStep: {
    update: vi.fn(),
  },
}
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

beforeEach(() => vi.clearAllMocks())

describe('planner', () => {
  it('createPlan persists goal and steps with correct sequence', async () => {
    const { createPlan } = await import('@/agent/lib/planner')

    const fakePlan = {
      id: 'plan-1',
      goal: 'Eid campaign setup',
      status: 'draft',
      selfCheckNote: null,
      steps: [
        { id: 's1', seq: 1, action: 'Research competitors', toolName: null, dependsOn: [], status: 'pending', result: null, error: null },
        { id: 's2', seq: 2, action: 'Create ad creative', toolName: 'make_ad_creatives', dependsOn: ['s1'], status: 'pending', result: null, error: null },
        { id: 's3', seq: 3, action: 'Set budget', toolName: 'update_campaign_budget', dependsOn: ['s2'], status: 'pending', result: null, error: null },
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

  it('getReadySteps returns only steps with all deps done', async () => {
    const { getReadySteps } = await import('@/agent/lib/planner')

    const plan = {
      id: 'p1',
      goal: 'Test',
      status: 'executing' as const,
      steps: [
        { id: 's1', action: 'Step 1', dependsOn: [], status: 'done' as const },
        { id: 's2', action: 'Step 2', dependsOn: ['s1'], status: 'pending' as const },
        { id: 's3', action: 'Step 3', dependsOn: ['s1', 's2'], status: 'pending' as const },
        { id: 's4', action: 'Step 4', dependsOn: [], status: 'pending' as const },
      ],
    }

    const ready = getReadySteps(plan)
    expect(ready.map(s => s.id)).toEqual(['s2', 's4'])
  })

  it('getReadySteps blocks step when dependency not done', async () => {
    const { getReadySteps } = await import('@/agent/lib/planner')

    const plan = {
      id: 'p1',
      goal: 'Test',
      status: 'executing' as const,
      steps: [
        { id: 's1', action: 'Step 1', dependsOn: [], status: 'pending' as const },
        { id: 's2', action: 'Step 2', dependsOn: ['s1'], status: 'pending' as const },
      ],
    }

    const ready = getReadySteps(plan)
    expect(ready.map(s => s.id)).toEqual(['s1'])
  })

  it('selfCheck reports failures correctly', async () => {
    const { selfCheck } = await import('@/agent/lib/planner')

    const plan = {
      id: 'p1',
      goal: 'Test',
      status: 'executing' as const,
      steps: [
        { id: 's1', action: 'Step 1', dependsOn: [], status: 'done' as const },
        { id: 's2', action: 'Step 2 (failed)', dependsOn: ['s1'], status: 'failed' as const, error: 'API error' },
        { id: 's3', action: 'Step 3', dependsOn: ['s2'], status: 'pending' as const },
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
      id: 'p1',
      goal: 'Test',
      status: 'done' as const,
      steps: [
        { id: 's1', action: 'Step 1', dependsOn: [], status: 'done' as const },
        { id: 's2', action: 'Step 2', dependsOn: ['s1'], status: 'done' as const },
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
        { id: 's1', action: 'Original', toolName: undefined, dependsOn: [], status: 'done' as const },
        { id: 's2', action: 'সংশোধন: x', toolName: AUTOREPAIR_TOOL, dependsOn: [], status: 'done' as const },
        { id: 's3', action: 'সংশোধন: y', toolName: AUTOREPAIR_TOOL, dependsOn: [], status: 'pending' as const },
      ],
    }

    expect(countRepairSteps(plan)).toBe(2)
  })

  it('countRepairSteps returns 0 when no corrective steps', async () => {
    const { countRepairSteps } = await import('@/agent/lib/planner')

    const plan = {
      steps: [
        { id: 's1', action: 'A', toolName: 'make_ad_creatives', dependsOn: [], status: 'done' as const },
        { id: 's2', action: 'B', toolName: undefined, dependsOn: [], status: 'pending' as const },
      ],
    }

    expect(countRepairSteps(plan)).toBe(0)
  })

  it('hasFailed returns true when any step failed', async () => {
    const { hasFailed } = await import('@/agent/lib/planner')

    const plan = {
      id: 'p1',
      goal: 'Test',
      status: 'executing' as const,
      steps: [
        { id: 's1', action: 'OK', dependsOn: [], status: 'done' as const },
        { id: 's2', action: 'Bad', dependsOn: [], status: 'failed' as const },
      ],
    }

    expect(hasFailed(plan)).toBe(true)
  })
})
