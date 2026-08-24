import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  messageFindMany: vi.fn(),
  messageUpdate: vi.fn(),
  messageCreate: vi.fn(),
  ensureDriveConversation: vi.fn(),
  buildBinding: vi.fn(),
  enqueueContinuation: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentMessage: {
      findMany: mocks.messageFindMany,
      update: mocks.messageUpdate,
      create: mocks.messageCreate,
    },
  },
}))
vi.mock('@/agent/lib/models/run-owner-turn', () => ({ runOwnerTurn: vi.fn() }))
vi.mock('@/agent/lib/turn-status', () => ({
  createTurn: vi.fn(),
  finalizeTurnIfRunning: vi.fn(),
}))
vi.mock('@/agent/lib/turn-queue', () => ({
  buildTurnJobData: vi.fn(),
  enqueueTurnJob: vi.fn(),
  isTurnHandoffConfigured: vi.fn(),
}))
vi.mock('@/agent/lib/plan-driver/drive-conversation', () => ({
  ensureDriveConversation: mocks.ensureDriveConversation,
}))
vi.mock('@/agent/lib/continuation-binding', () => ({
  buildPlanStepContinuationBinding: mocks.buildBinding,
}))
vi.mock('@/agent/lib/approval-continuation', () => ({
  enqueueAgentContinuation: mocks.enqueueContinuation,
}))

import { executeStep } from '@/agent/lib/plan-driver/executor'

const binding = {
  v: 1 as const,
  origin: 'plan_driver' as const,
  source: { kind: 'plan_step' as const, id: 'step-1' },
  conversationId: 'conversation-1',
  domain: 'seo' as const,
  event: 'step_dispatch' as const,
  planId: 'plan-1',
  subidentity: 'attempt-1',
  directive: { kind: 'plan_step_execute' as const, version: 1 as const },
  expected: { sourceStatus: ['running'], sourceType: '__grind_diagnose' },
  steeringMessageIds: ['owner-steer-1'],
}

const plan = {
  id: 'plan-1', goal: 'SEO diagnose', conversationId: 'conversation-1', businessId: 'ALMA_LIFESTYLE',
}
const step = {
  id: 'step-1', action: 'Find the root cause', toolName: '__grind_diagnose',
  dependsOn: [], status: 'running' as const, attemptCount: 0, maxAttempts: 3,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ensureDriveConversation.mockResolvedValue('conversation-1')
  mocks.messageFindMany.mockResolvedValue([
    {
      id: 'engine-directive-old',
      content: [{ type: 'text', text: 'old internal directive' }],
      usage: { driverDirective: true },
    },
    {
      id: 'owner-steer-1',
      content: [{ type: 'text', text: 'Check canonical tags first' }],
      usage: {},
    },
  ])
  mocks.messageUpdate.mockResolvedValue({})
  mocks.buildBinding.mockResolvedValue(binding)
  mocks.enqueueContinuation.mockResolvedValue({
    outcome: 'queued', turnId: 'bound-plan-turn', requestId: 'plan-request', status: 'running',
  })
})

describe('source-bound plan step execution', () => {
  it('queues only the exact bound plan step and persisted owner steering IDs', async () => {
    const result = await executeStep(plan, step, {
      businessId: 'ALMA_LIFESTYLE', driverModelId: 'or-deepseek-v4-flash',
    })

    expect(mocks.buildBinding).toHaveBeenCalledWith({
      stepId: 'step-1',
      conversationId: 'conversation-1',
      steeringMessageIds: ['owner-steer-1'],
    })
    expect(mocks.enqueueContinuation).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      binding,
      force: true,
      // Execution SCOPE must survive the continuation (Codex P1 #847): the
      // pre-source-binding inline path passed both, and dropping them ran an
      // ALMA_TRADING plan in the ALMA_LIFESTYLE context on the default head.
      businessId: 'ALMA_LIFESTYLE',
      modelId: 'or-deepseek-v4-flash',
    })
    expect(mocks.enqueueContinuation.mock.calls[0][0].message).toBeUndefined()
    expect(mocks.messageCreate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ dispatched: true, turnId: 'bound-plan-turn' })
  })

  it('force-inline still claims the same bound source and never persists directive prose as owner text', async () => {
    mocks.enqueueContinuation.mockResolvedValue({
      outcome: 'completed', turnId: 'bound-inline-turn', requestId: 'inline-request', status: 'done',
    })
    const result = await executeStep(plan, step, {
      businessId: 'ALMA_LIFESTYLE', driverModelId: 'or-deepseek-v4-flash', forceInline: true,
    })

    expect(mocks.enqueueContinuation).toHaveBeenCalledWith({
      conversationId: 'conversation-1', binding, force: true, forceInline: true,
      businessId: 'ALMA_LIFESTYLE', modelId: 'or-deepseek-v4-flash',
    })
    expect(mocks.messageCreate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ dispatched: true, turnId: 'bound-inline-turn' })
  })

  it('carries a TRADING plan scope and the pinned driver model into the continuation', async () => {
    await executeStep(plan, step, {
      businessId: 'ALMA_TRADING', driverModelId: 'gpt-5.6-luna', forceInline: true,
    })

    const passed = mocks.enqueueContinuation.mock.calls[0][0]
    expect(passed.businessId).toBe('ALMA_TRADING')
    expect(passed.modelId).toBe('gpt-5.6-luna')
  })

  it('fails visibly before model/lane/tool execution when source binding cannot be built', async () => {
    mocks.buildBinding.mockRejectedValue(new Error('continuation_plan_not_driving'))

    const result = await executeStep(plan, step, {
      businessId: 'ALMA_LIFESTYLE', driverModelId: 'or-deepseek-v4-flash',
    })

    expect(result).toMatchObject({ ok: false, dispatched: false })
    expect(result.error).toContain('source-bound plan dispatch failed')
    expect(mocks.enqueueContinuation).not.toHaveBeenCalled()
  })
})
