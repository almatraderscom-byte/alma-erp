import { beforeEach, describe, expect, it, vi } from 'vitest'

const planner = vi.hoisted(() => ({
  createPlan: vi.fn(),
  loadPlan: vi.fn(),
  updatePlanStatus: vi.fn(),
  selfCheck: vi.fn(),
  formatPlanForDisplay: vi.fn(),
  enrollPlanForAutodrive: vi.fn(),
}))

vi.mock('@/agent/lib/planner', () => planner)
vi.mock('@/agent/lib/autodrive-config', () => ({ isAutodriveEnabled: () => true }))

import { ORCHESTRATOR_TOOLS } from '@/agent/tools/orchestrator-tools'

const executePlan = ORCHESTRATOR_TOOLS.find((tool) => tool.name === 'execute_plan')!

const persistedPlan = {
  id: 'plan-read-only',
  goal: 'Read dashboard, orders, approvals, then summarize',
  status: 'draft',
  businessId: 'ALMA_LIFESTYLE',
  steps: [],
  autodriveState: 'idle',
  attemptCount: 0,
  maxAttempts: 3,
  costTaka: 0,
  costMilliTaka: 0,
  costMilliTakaDay: 0,
}

describe('execute_plan owner-turn boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    planner.loadPlan.mockResolvedValue(persistedPlan)
    planner.updatePlanStatus.mockResolvedValue(undefined)
    planner.selfCheck.mockReturnValue({
      allDone: false,
      completedCount: 0,
      totalCount: 4,
      failedSteps: [],
      pendingSteps: ['step-1', 'step-2', 'step-3', 'step-4'],
    })
    planner.formatPlanForDisplay.mockReturnValue('four-step plan')
  })

  it('advances plan metadata but never enrolls autodrive on a read-only turn', async () => {
    const result = await executePlan.handler({
      plan_id: persistedPlan.id,
      delegatedToolContext: {
        turnAuthorization: { allowMutations: false, reason: 'explicit_no_action' },
      },
    })

    expect(result.success).toBe(true)
    expect(planner.enrollPlanForAutodrive).not.toHaveBeenCalled()
    expect(planner.updatePlanStatus).toHaveBeenNthCalledWith(1, persistedPlan.id, 'executing')
    expect(planner.updatePlanStatus).toHaveBeenNthCalledWith(
      2,
      persistedPlan.id,
      'approved',
      expect.stringContaining('0/4 done'),
    )
  })

  it('keeps the existing autodrive behavior for an authorized action turn', async () => {
    const result = await executePlan.handler({
      plan_id: persistedPlan.id,
      delegatedToolContext: {
        turnAuthorization: { allowMutations: true, reason: 'explicit_action' },
      },
    })

    expect(result.success).toBe(true)
    expect(planner.enrollPlanForAutodrive).toHaveBeenCalledWith(persistedPlan.id, {
      doneCriteria: undefined,
    })
    expect(planner.updatePlanStatus).not.toHaveBeenCalled()
  })
})
