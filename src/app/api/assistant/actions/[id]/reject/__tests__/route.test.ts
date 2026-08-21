import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  isSystemOwner: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  messageCreate: vi.fn(),
  conversationUpdate: vi.fn(),
  anthropicCreate: vi.fn(),
  settlePlanStepsLinkedToPendingAction: vi.fn(),
  settleRejectedPlanStepsInTransaction: vi.fn(),
  completeRejectedDelegationPlanStepsInTransaction: vi.fn(),
  reconcilePlanTrackersForPendingAction: vi.fn(),
  pushCurrentPulseLiveActivity: vi.fn(),
  syncWorkflowWithPendingAction: vi.fn(),
  logCost: vi.fn(),
}))

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: mocks.isSystemOwner }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: mocks.transaction,
    $queryRaw: mocks.queryRaw,
    agentPendingAction: {
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
      update: mocks.update,
    },
    agentMessage: { create: mocks.messageCreate },
    agentConversation: { update: mocks.conversationUpdate },
  },
}))
vi.mock('@/agent/lib/planner', () => ({
  settlePlanStepsLinkedToPendingAction: mocks.settlePlanStepsLinkedToPendingAction,
  settleRejectedPlanStepsInTransaction: mocks.settleRejectedPlanStepsInTransaction,
  completeRejectedDelegationPlanStepsInTransaction: mocks.completeRejectedDelegationPlanStepsInTransaction,
  reconcilePlanTrackersForPendingAction: mocks.reconcilePlanTrackersForPendingAction,
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mocks.anthropicCreate }
  },
}))
vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('crypto')>()),
  randomUUID: () => 'claim-1',
}))
vi.mock('@/agent/lib/pulse-live-update', () => ({
  pushCurrentPulseLiveActivity: mocks.pushCurrentPulseLiveActivity,
}))
vi.mock('@/agent/lib/workflow-run', () => ({
  syncWorkflowWithPendingAction: mocks.syncWorkflowWithPendingAction,
}))
vi.mock('@/agent/lib/tool-telemetry', () => ({ logToolEvent: vi.fn() }))
vi.mock('@/agent/lib/cost-events', () => ({ logCost: mocks.logCost }))

import { POST } from '../route'

describe('POST /api/assistant/actions/[id]/reject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getToken.mockResolvedValue({ sub: 'owner-1' })
    mocks.isSystemOwner.mockReturnValue(true)
    mocks.settlePlanStepsLinkedToPendingAction.mockResolvedValue(null)
    mocks.reconcilePlanTrackersForPendingAction.mockResolvedValue(undefined)
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.update.mockResolvedValue({})
    mocks.queryRaw.mockResolvedValue([])
    mocks.messageCreate.mockResolvedValue({ id: 'message-1' })
    mocks.conversationUpdate.mockResolvedValue({})
    mocks.completeRejectedDelegationPlanStepsInTransaction.mockResolvedValue(undefined)
    mocks.settleRejectedPlanStepsInTransaction.mockResolvedValue(undefined)
    mocks.pushCurrentPulseLiveActivity.mockResolvedValue(undefined)
    mocks.syncWorkflowWithPendingAction.mockResolvedValue(undefined)
    mocks.logCost.mockResolvedValue(undefined)
    mocks.transaction.mockImplementation(
      async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => callback({
        $queryRaw: mocks.queryRaw,
        agentPendingAction: {
          findUnique: mocks.findUnique,
          updateMany: mocks.updateMany,
          update: mocks.update,
        },
        agentMessage: { create: mocks.messageCreate },
        agentConversation: { update: mocks.conversationUpdate },
      }),
    )
  })

  it('idempotently repairs the linked plan row when a rejected action is retried', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'action-1', status: 'rejected' })

    const response = await POST(
      new NextRequest('https://alma.test/api/assistant/actions/action-1/reject', { method: 'POST' }),
      { params: Promise.resolve({ id: 'action-1' }) },
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'already_resolved',
      status: 'rejected',
    })
    expect(mocks.settlePlanStepsLinkedToPendingAction).toHaveBeenCalledWith('action-1')
    expect(mocks.reconcilePlanTrackersForPendingAction).toHaveBeenCalledWith('action-1')
  })

  it('does not settle a competing approved action through the reject endpoint', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'action-1', status: 'approved' })

    const response = await POST(
      new NextRequest('https://alma.test/api/assistant/actions/action-1/reject', { method: 'POST' }),
      { params: Promise.resolve({ id: 'action-1' }) },
    )

    expect(response.status).toBe(409)
    expect(mocks.settlePlanStepsLinkedToPendingAction).not.toHaveBeenCalled()
    expect(mocks.reconcilePlanTrackersForPendingAction).not.toHaveBeenCalled()
  })

  it('does not report an already-rejected action resolved while its tracker projection is stale', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'action-1', status: 'rejected', type: 'publish' })
    mocks.reconcilePlanTrackersForPendingAction.mockRejectedValueOnce(new Error('projection stale'))

    await expect(POST(
      new NextRequest('https://alma.test/api/assistant/actions/action-1/reject', { method: 'POST' }),
      { params: Promise.resolve({ id: 'action-1' }) },
    )).rejects.toThrow('projection stale')
  })

  it('persists the delegation fallback answer and completes its plan row atomically', async () => {
    const pending = {
      id: 'action-1', status: 'pending', type: 'delegation', createdAt: new Date(),
      payload: { task: 'Summarize the dashboard' }, conversationId: 'conversation-1',
      businessId: 'ALMA_LIFESTYLE', result: null,
    }
    mocks.findUnique
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ...pending, status: 'rejected' })
      .mockResolvedValueOnce({
        ...pending, status: 'rejected',
        result: { delegationFallbackClaimId: 'claim-1' },
      })
    mocks.anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'পূর্ণ উত্তর' }],
      usage: { input_tokens: 12, output_tokens: 8 },
    })

    const response = await POST(
      new NextRequest('https://alma.test/api/assistant/actions/action-1/reject', { method: 'POST' }),
      { params: Promise.resolve({ id: 'action-1' }) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true, status: 'rejected', answered: true,
      assistantMessageId: 'message-1', replayed: false,
    })
    expect(mocks.settleRejectedPlanStepsInTransaction).not.toHaveBeenCalled()
    expect(mocks.messageCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        conversationId: 'conversation-1',
        content: [{ type: 'text', text: 'পূর্ণ উত্তর' }],
      }),
    }))
    expect(mocks.completeRejectedDelegationPlanStepsInTransaction).toHaveBeenCalledWith(
      expect.any(Object), expect.objectContaining({ status: 'rejected' }), 'message-1',
    )
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { result: expect.objectContaining({ delegationFallbackMessageId: 'message-1' }) },
    }))
    expect(mocks.reconcilePlanTrackersForPendingAction).toHaveBeenCalledWith('action-1')
  })

  it('marks a delegation row failed only when the head fallback actually fails', async () => {
    const pending = {
      id: 'action-1', status: 'pending', type: 'delegation', createdAt: new Date(),
      payload: { task: 'Summarize the dashboard' }, conversationId: 'conversation-1',
      businessId: 'ALMA_LIFESTYLE', result: null,
    }
    mocks.findUnique
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ...pending, status: 'rejected' })
      .mockResolvedValueOnce({
        ...pending, status: 'rejected',
        result: { delegationFallbackClaimId: 'claim-1' },
      })
    mocks.anthropicCreate.mockRejectedValueOnce(new Error('provider unavailable'))

    const response = await POST(
      new NextRequest('https://alma.test/api/assistant/actions/action-1/reject', { method: 'POST' }),
      { params: Promise.resolve({ id: 'action-1' }) },
    )

    expect(response.status).toBe(502)
    expect(mocks.messageCreate).not.toHaveBeenCalled()
    expect(mocks.completeRejectedDelegationPlanStepsInTransaction).not.toHaveBeenCalled()
    expect(mocks.settleRejectedPlanStepsInTransaction).toHaveBeenCalledOnce()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { result: expect.objectContaining({
        delegationFallbackFailed: true,
        delegationFallbackError: 'provider unavailable',
      }) },
    }))
  })

  it('does not run a second provider call while a delegation fallback lease is active', async () => {
    const rejected = {
      id: 'action-1', status: 'rejected', type: 'delegation', createdAt: new Date(),
      payload: { task: 'Summarize the dashboard' }, conversationId: 'conversation-1',
      businessId: 'ALMA_LIFESTYLE',
      result: {
        delegationFallbackClaimId: 'other-claim',
        delegationFallbackClaimedAt: new Date().toISOString(),
      },
    }
    mocks.findUnique
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(rejected)

    const response = await POST(
      new NextRequest('https://alma.test/api/assistant/actions/action-1/reject', { method: 'POST' }),
      { params: Promise.resolve({ id: 'action-1' }) },
    )

    expect(response.status).toBe(202)
    expect(mocks.anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.messageCreate).not.toHaveBeenCalled()
  })
})
