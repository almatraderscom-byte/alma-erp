import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import {
  buildImageActionQuote,
  IMAGE_WORKER_CAPABILITY_KV_KEY,
  IMAGE_WORKER_CAPABILITY_SOURCE,
  IMAGE_WORKER_CAPABILITY_VERSION,
} from '@/agent/lib/image-action-contract'

type ImageAction = {
  id: string
  type: 'image_gen'
  status: string
  summary: string
  conversationId: string | null
  businessId: string
  createdAt: Date
  payload: Record<string, unknown>
  imageModel: string | null
  imageQuote: unknown
  approvalClaimedAt: Date | null
  ownerDecided: boolean | null
  resolvedAt?: Date | null
}

const mocks = vi.hoisted(() => ({
  action: null as ImageAction | null,
  readKv: vi.fn(),
  pendingFindUnique: vi.fn(),
  pendingUpdate: vi.fn(),
  pendingUpdateMany: vi.fn(),
  messageCreate: vi.fn(),
  conversationUpdate: vi.fn(),
  createTurn: vi.fn(),
  finalizeTurn: vi.fn(),
  traceTurnStage: vi.fn(),
  enqueueContinuation: vi.fn(),
  syncWorkflow: vi.fn(),
  workflowBlocksApproval: vi.fn(),
  pushPulse: vi.fn(),
  recordApproval: vi.fn(),
  settlePlanStepsLinkedToPendingAction: vi.fn(),
  reconcilePlanTrackersForPendingAction: vi.fn(),
}))

vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: () => true }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      findUnique: mocks.pendingFindUnique,
      update: mocks.pendingUpdate,
      updateMany: mocks.pendingUpdateMany,
    },
    agentMessage: { create: mocks.messageCreate },
    agentConversation: { update: mocks.conversationUpdate },
  },
}))
vi.mock('@/agent/lib/approval-continuation', () => ({
  enqueueApprovedActionContinuation: mocks.enqueueContinuation,
}))
vi.mock('@/agent/lib/turn-status', () => ({
  createTurn: mocks.createTurn,
  finalizeTurnIfRunning: mocks.finalizeTurn,
}))
vi.mock('@/agent/lib/turn-stage-trace', () => ({ traceTurnStage: mocks.traceTurnStage }))
vi.mock('@/agent/lib/workflow-run', () => ({
  workflowBlocksApproval: mocks.workflowBlocksApproval,
  syncWorkflowWithPendingAction: mocks.syncWorkflow,
}))
vi.mock('@/agent/lib/pulse-live-update', () => ({ pushCurrentPulseLiveActivity: mocks.pushPulse }))
vi.mock('@/agent/lib/trust-engine', () => ({ recordApproval: mocks.recordApproval }))
vi.mock('@/agent/lib/pending-action', () => ({ isPendingActionExpired: () => false }))
vi.mock('@/agent/lib/planner', () => ({
  settlePlanStepsLinkedToPendingAction: mocks.settlePlanStepsLinkedToPendingAction,
  reconcilePlanTrackersForPendingAction: mocks.reconcilePlanTrackersForPendingAction,
}))
vi.mock('@/lib/creative-studio/taste', () => ({ readKv: mocks.readKv }))
vi.mock('@/lib/creative-studio/preview-worker-scope', () => ({
  creativeStudioImageQueueStatus: () => 'approved',
}))
vi.mock('@/agent/lib/graph/action-bridge', () => ({
  guardBridgeDecision: () => 'ok',
  bridgeVerdictMessageBn: () => 'ok',
  resumeDecisionThread: vi.fn(async () => ({ alreadyConsumed: false })),
}))
vi.mock('@/agent/lib/duty-approval-block', () => ({ resolveDutyBlocksForLinkedAction: vi.fn() }))

// Imported by other approval branches but never exercised in these image-only
// tests. Keeping them inert makes the test a deterministic claim/CAS harness.
vi.mock('@/agent/lib/meta', () => ({ createPagePost: vi.fn(), verifyPost: vi.fn(), resolvePageId: vi.fn() }))
vi.mock('@/agent/lib/fb-image-resolve', () => ({ resolveFbPostImageRef: vi.fn() }))
vi.mock('@/agent/lib/meta-ads', () => ({ pauseCampaign: vi.fn(), updateCampaignBudget: vi.fn() }))
vi.mock('@/lib/owner-call-lock', () => ({ setOwnerCallLockUntil: vi.fn() }))
vi.mock('@/agent/lib/voice-call', () => ({ placeOutboundCall: vi.fn() }))
vi.mock('@/agent/lib/mac-agent/bus', () => ({
  activeDevice: vi.fn(),
  awaitResult: vi.fn(),
  enqueueCommand: vi.fn(),
  isMacAgentEnabled: vi.fn(() => false),
  isMacUiDrivingEnabled: vi.fn(() => false),
  listDevices: vi.fn(),
  UI_SERVER_IDLE_SENTINEL: 'idle',
}))
vi.mock('@/agent/lib/mac-agent/policy', () => ({ classifyCommand: vi.fn() }))
vi.mock('@/agent/lib/mac-agent/ui-policy', () => ({ classifyUiAction: vi.fn() }))

import { POST as approveImage } from '@/app/api/assistant/actions/[id]/approve/route'
import { POST as editImage } from '@/app/api/assistant/actions/[id]/route'

const oldInternalToken = process.env.AGENT_INTERNAL_TOKEN

function action(): ImageAction {
  return {
    id: 'image-action',
    type: 'image_gen',
    status: 'pending',
    summary: 'Generate image\nModel: Nano Banana Pro',
    conversationId: 'conversation-1',
    businessId: 'ALMA_LIFESTYLE',
    createdAt: new Date(),
    payload: {
      conversationId: 'conversation-1',
      prompt: 'A premium product photo',
      quality: 'pro',
      imageSize: '2K',
      variationCount: 4,
      pipelineMode: 'preview',
      aspectRatio: '4:5',
    },
    imageModel: 'gemini-3-pro-image',
    imageQuote: buildImageActionQuote({
      model: 'gemini-3-pro-image',
      quality: 'pro',
      imageSize: '2K',
      requestedImages: 4,
      pipelineMode: 'preview',
      aspectRatio: '4:5',
    }),
    approvalClaimedAt: null,
    ownerDecided: null,
  }
}

function request(body?: Record<string, unknown>) {
  return new NextRequest('https://alma.test/api/assistant/actions/image-action/approve', {
    method: 'POST',
    headers: {
      authorization: 'Bearer internal-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  })
}

function freshWorkerReceipt() {
  return JSON.stringify({
    version: IMAGE_WORKER_CAPABILITY_VERSION,
    source: IMAGE_WORKER_CAPABILITY_SOURCE,
    updatedAt: new Date().toISOString(),
    models: ['gemini-3.1-flash-image', 'gemini-3-pro-image'],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AGENT_INTERNAL_TOKEN = 'internal-test-token'
  mocks.action = action()
  mocks.pendingFindUnique.mockImplementation(async () => mocks.action)
  mocks.pendingUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    if (!mocks.action) throw new Error('missing action')
    if (data.payload && typeof data.payload === 'object') {
      mocks.action.payload = data.payload as Record<string, unknown>
    }
    if (typeof data.ownerDecided === 'boolean') mocks.action.ownerDecided = data.ownerDecided
    return mocks.action
  })
  mocks.pendingUpdateMany.mockImplementation(async ({ where, data }: {
    where: Record<string, unknown>
    data: Record<string, unknown>
  }) => {
    const row = mocks.action
    if (!row || (where.status && where.status !== row.status)) return { count: 0 }
    if (where.approvalClaimedAt === null && row.approvalClaimedAt !== null) return { count: 0 }
    if (where.approvalClaimedAt instanceof Date) {
      if (row.approvalClaimedAt?.getTime() !== where.approvalClaimedAt.getTime()) return { count: 0 }
    } else if (
      where.approvalClaimedAt
      && typeof where.approvalClaimedAt === 'object'
      && 'lt' in (where.approvalClaimedAt as Record<string, unknown>)
    ) {
      const staleBefore = (where.approvalClaimedAt as { lt: Date }).lt
      if (!row.approvalClaimedAt || row.approvalClaimedAt >= staleBefore) return { count: 0 }
    }
    if ('imageModel' in where && where.imageModel !== row.imageModel) return { count: 0 }
    if (data.approvalClaimedAt instanceof Date) row.approvalClaimedAt = data.approvalClaimedAt
    if (data.approvalClaimedAt === null) row.approvalClaimedAt = null
    if (data.ownerDecided === null) row.ownerDecided = null
    if (typeof data.status === 'string') row.status = data.status
    if (data.resolvedAt instanceof Date) row.resolvedAt = data.resolvedAt
    if (data.payload && typeof data.payload === 'object') row.payload = data.payload as Record<string, unknown>
    if (typeof data.imageModel === 'string') row.imageModel = data.imageModel
    if (data.imageQuote) row.imageQuote = data.imageQuote
    if (typeof data.summary === 'string') row.summary = data.summary
    return { count: 1 }
  })
  mocks.messageCreate.mockResolvedValue({})
  mocks.conversationUpdate.mockResolvedValue({})
  mocks.createTurn.mockResolvedValue('turn-1')
  mocks.finalizeTurn.mockResolvedValue(undefined)
  mocks.traceTurnStage.mockResolvedValue(undefined)
  mocks.enqueueContinuation.mockResolvedValue(undefined)
  mocks.workflowBlocksApproval.mockResolvedValue({ blocked: false })
  mocks.syncWorkflow.mockResolvedValue(undefined)
  mocks.pushPulse.mockResolvedValue(undefined)
  mocks.recordApproval.mockResolvedValue(undefined)
  mocks.settlePlanStepsLinkedToPendingAction.mockResolvedValue(null)
  mocks.reconcilePlanTrackersForPendingAction.mockResolvedValue(undefined)
  mocks.readKv.mockImplementation(async (key: string) => {
    if (key === 'cs_image_models') {
      return JSON.stringify({ standard: 'gemini-3.1-flash-image', pro: 'gemini-3-pro-image' })
    }
    if (key === IMAGE_WORKER_CAPABILITY_KV_KEY) return freshWorkerReceipt()
    return '0'
  })
})

afterEach(() => {
  if (oldInternalToken === undefined) delete process.env.AGENT_INTERNAL_TOKEN
  else process.env.AGENT_INTERNAL_TOKEN = oldInternalToken
})

describe('image approval request claim', () => {
  it('repairs a terminal approval before returning already resolved', async () => {
    mocks.action!.status = 'executed'

    const response = await approveImage(request(), { params: Promise.resolve({ id: 'image-action' }) })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'already_resolved', status: 'executed',
    })
    expect(mocks.settlePlanStepsLinkedToPendingAction).toHaveBeenCalledWith('image-action')
    expect(mocks.reconcilePlanTrackersForPendingAction).toHaveBeenCalledWith('image-action')
    expect(mocks.messageCreate).not.toHaveBeenCalled()
  })

  it('does not fail the plan for a rejected delegation whose head fallback is still leased', async () => {
    Object.assign(mocks.action as unknown as Record<string, unknown>, {
      type: 'delegation',
      status: 'rejected',
      result: {
        delegationFallbackClaimId: 'fallback-claim',
        delegationFallbackClaimedAt: new Date().toISOString(),
      },
    })

    const response = await approveImage(request(), { params: Promise.resolve({ id: 'image-action' }) })

    expect(response.status).toBe(409)
    expect(mocks.settlePlanStepsLinkedToPendingAction).not.toHaveBeenCalled()
    expect(mocks.reconcilePlanTrackersForPendingAction).not.toHaveBeenCalled()
  })

  it('releases the exact claim when model preflight throws so the owner can retry', async () => {
    mocks.readKv.mockRejectedValueOnce(new Error('KV unavailable'))

    const response = await approveImage(request(), { params: Promise.resolve({ id: 'image-action' }) })

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: 'image_approval_failed',
      retryable: true,
    })
    expect(mocks.action).toMatchObject({
      status: 'pending',
      approvalClaimedAt: null,
      ownerDecided: null,
    })
    expect(mocks.finalizeTurn).toHaveBeenCalledWith('turn-1', 'error')
  })

  it('fails closed and releases the approval claim when the worker receipt is missing', async () => {
    mocks.readKv.mockImplementation(async (key: string) => {
      if (key === 'cs_image_models') {
        return JSON.stringify({ standard: 'gemini-3.1-flash-image', pro: 'gemini-3-pro-image' })
      }
      if (key === IMAGE_WORKER_CAPABILITY_KV_KEY) return null
      return '0'
    })

    const response = await approveImage(request(), { params: Promise.resolve({ id: 'image-action' }) })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: 'image_model_unavailable',
      message: expect.stringContaining('missing'),
      retryable: true,
    })
    expect(mocks.action).toMatchObject({
      status: 'pending',
      approvalClaimedAt: null,
      ownerDecided: null,
    })
  })

  it('allows one approve progress context and rejects a double tap plus a racing model edit', async () => {
    let releasePreflight: () => void = () => {}
    const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve })
    let blockedConfiguredRead = false
    mocks.readKv.mockImplementation(async (key: string) => {
      if (key === 'cs_image_models' && !blockedConfiguredRead) {
        blockedConfiguredRead = true
        await preflightGate
      }
      if (key === 'cs_image_models') {
        return JSON.stringify({ standard: 'gemini-3.1-flash-image', pro: 'gemini-3-pro-image' })
      }
      if (key === IMAGE_WORKER_CAPABILITY_KV_KEY) return freshWorkerReceipt()
      return '0'
    })

    const winnerPromise = approveImage(request(), { params: Promise.resolve({ id: 'image-action' }) })
    await vi.waitFor(() => expect(mocks.action!.approvalClaimedAt).toBeInstanceOf(Date))
    await vi.waitFor(() => expect(mocks.messageCreate).toHaveBeenCalledTimes(1))

    const [doubleTap, modelEdit] = await Promise.all([
      approveImage(request(), { params: Promise.resolve({ id: 'image-action' }) }),
      editImage(request({ imageModel: 'gemini-3.1-flash-image' }), {
        params: Promise.resolve({ id: 'image-action' }),
      }),
    ])
    expect(doubleTap.status).toBe(409)
    await expect(doubleTap.json()).resolves.toMatchObject({ error: 'approval_in_progress' })
    expect(modelEdit.status).toBe(409)
    await expect(modelEdit.json()).resolves.toMatchObject({ error: 'image_model_changed' })
    expect(mocks.messageCreate).toHaveBeenCalledTimes(1)
    expect(mocks.createTurn).toHaveBeenCalledTimes(1)
    expect(mocks.action!.imageModel).toBe('gemini-3-pro-image')

    releasePreflight()
    const winner = await winnerPromise
    expect(winner.status).toBe(200)
    expect(mocks.action).toMatchObject({
      status: 'approved',
      approvalClaimedAt: null,
      imageModel: 'gemini-3-pro-image',
    })
    expect((mocks.action!.payload as Record<string, unknown>).imageModel).toBe('gemini-3-pro-image')
  })
})
