import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Action = {
  id: string
  type: string
  status: string
  summary: string
  conversationId: string
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  jobResultPending: boolean
  jobResultEnvelope?: Record<string, unknown> | null
  jobResultClaimedAt?: Date | null
  resolvedAt?: Date
}

const mocks = vi.hoisted(() => ({
  action: null as Action | null,
  messages: new Map<string, unknown>(),
  pendingUpdateMany: vi.fn(),
  pendingFindUnique: vi.fn(),
  messageUpsert: vi.fn(),
  messageCreate: vi.fn(),
  conversationUpdate: vi.fn(),
  workflowRelease: vi.fn(),
  workflowSync: vi.fn(),
  workflowGet: vi.fn(),
  writeCheckpoint: vi.fn(),
  resolveCheckpoint: vi.fn(),
  finalizeTurn: vi.fn(),
  pipelineComplete: vi.fn(),
  markDeliveryPending: vi.fn(),
  beforeTerminalCas: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/agent/lib/storage', () => ({
  agentStorageSignedUrl: vi.fn(async (path: string) => `https://signed.test/${path}`),
}))
vi.mock('@/agent/lib/approval-continuation', () => ({ enqueueAgentContinuation: vi.fn() }))
vi.mock('@/agent/lib/turn-status', () => ({ finalizeTurnIfRunning: mocks.finalizeTurn }))
vi.mock('@/agent/lib/telegram-owner-notify', () => ({ sendOwnerText: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/agent/lib/job-delivery', () => ({
  buildFallbackDeliveryMessage: vi.fn(),
  hasUnansweredAskCard: vi.fn(async () => false),
  isDeliverableJobType: vi.fn(() => true),
  markDelivered: vi.fn(),
  markDeliveryPending: mocks.markDeliveryPending,
  postAssistantMessage: vi.fn(),
}))
vi.mock('@/agent/lib/workflow-run', () => ({
  releaseWorkflowLease: mocks.workflowRelease,
  syncWorkflowWithPendingAction: mocks.workflowSync,
  getWorkflowRunByPendingAction: mocks.workflowGet,
}))
vi.mock('@/agent/lib/checkpoint', () => ({
  writeCheckpoint: mocks.writeCheckpoint,
  resolveCheckpointByTaskRef: mocks.resolveCheckpoint,
}))
vi.mock('@/lib/content-engine/pipeline', () => ({ onPipelineRenderComplete: mocks.pipelineComplete }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      findUnique: mocks.pendingFindUnique,
      updateMany: mocks.pendingUpdateMany,
      update: vi.fn(),
    },
    agentMessage: {
      upsert: mocks.messageUpsert,
      create: mocks.messageCreate,
    },
    agentConversation: { update: mocks.conversationUpdate },
  },
}))

import { POST } from '@/app/api/assistant/internal/job-result/route'

const oldToken = process.env.AGENT_INTERNAL_TOKEN
let receiptSequence = 0

function terminalEnvelope(
  status: 'success' | 'failed',
  detail: { data?: Record<string, unknown>; error?: string } = {},
) {
  receiptSequence += 1
  return {
    version: 1,
    status,
    ...detail,
    receiptId: `receipt-${receiptSequence}`,
    recordedAt: '2026-08-11T00:00:00.000Z',
  }
}

function imageAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 'image-action',
    type: 'image_gen',
    status: 'approved',
    summary: 'Generate four product variations',
    conversationId: 'conversation-1',
    payload: { conversationId: 'conversation-1' },
    result: null,
    jobResultPending: true,
    ...overrides,
  }
}

function request(body: Record<string, unknown>) {
  return new NextRequest('https://alma.test/api/assistant/internal/job-result', {
    method: 'POST',
    headers: {
      authorization: 'Bearer internal-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.messages.clear()
  receiptSequence = 0
  mocks.action = imageAction()
  process.env.AGENT_INTERNAL_TOKEN = 'internal-test-token'
  mocks.pendingFindUnique.mockImplementation(async () => mocks.action)
  mocks.pendingUpdateMany.mockImplementation(async ({ where, data }: {
    where: Record<string, unknown>
    data: Record<string, unknown>
  }) => {
    const action = mocks.action
    if (typeof data.status === 'string' && data.jobResultPending === true) {
      await mocks.beforeTerminalCas(where, data)
    }
    if (!action || (where.status && where.status !== action.status)) return { count: 0 }
    if (
      typeof where.jobResultPending === 'boolean'
      && where.jobResultPending !== action.jobResultPending
    ) return { count: 0 }
    const envelopeFilter = where.jobResultEnvelope as {
      path?: string[]
      equals?: unknown
    } | undefined
    if (envelopeFilter?.path?.[0] === 'receiptId') {
      const currentReceipt = action.jobResultEnvelope?.receiptId
      if (currentReceipt !== envelopeFilter.equals) return { count: 0 }
    }
    if (data.jobResultClaimedAt instanceof Date && !data.status) {
      if (action.jobResultClaimedAt) return { count: 0 }
      action.jobResultClaimedAt = data.jobResultClaimedAt
      return { count: 1 }
    }
    if (
      where.jobResultClaimedAt instanceof Date
      && action.jobResultClaimedAt?.getTime() !== where.jobResultClaimedAt.getTime()
    ) return { count: 0 }
    if (typeof data.status === 'string') action.status = data.status
    if (data.result && typeof data.result === 'object') action.result = data.result as Record<string, unknown>
    if (data.resolvedAt instanceof Date) action.resolvedAt = data.resolvedAt
    if (data.jobResultEnvelope && typeof data.jobResultEnvelope === 'object') {
      action.jobResultEnvelope = data.jobResultEnvelope as Record<string, unknown>
    }
    if (data.jobResultPending === true) action.jobResultPending = true
    if (data.jobResultPending === false) action.jobResultPending = false
    if (data.jobResultClaimedAt === null) action.jobResultClaimedAt = null
    if (data.jobResultClaimedAt instanceof Date) action.jobResultClaimedAt = data.jobResultClaimedAt
    return { count: 1 }
  })
  mocks.messageUpsert.mockImplementation(async ({ where, create, update }: {
    where: { clientRequestId: string }
    create: unknown
    update?: Record<string, unknown>
  }) => {
    if (!mocks.messages.has(where.clientRequestId)) {
      mocks.messages.set(where.clientRequestId, create)
    } else if (update && typeof mocks.messages.get(where.clientRequestId) === 'object') {
      mocks.messages.set(where.clientRequestId, {
        ...(mocks.messages.get(where.clientRequestId) as Record<string, unknown>),
        ...update,
      })
    }
    return mocks.messages.get(where.clientRequestId)
  })
  mocks.messageCreate.mockResolvedValue({})
  mocks.conversationUpdate.mockResolvedValue({})
  mocks.workflowRelease.mockResolvedValue(undefined)
  mocks.workflowSync.mockResolvedValue(undefined)
  mocks.workflowGet.mockResolvedValue(null)
  mocks.writeCheckpoint.mockResolvedValue('checkpoint-1')
  mocks.resolveCheckpoint.mockResolvedValue(undefined)
  mocks.finalizeTurn.mockResolvedValue(undefined)
  mocks.pipelineComplete.mockResolvedValue(undefined)
  mocks.markDeliveryPending.mockResolvedValue(undefined)
})

afterEach(() => {
  if (oldToken === undefined) delete process.env.AGENT_INTERNAL_TOKEN
  else process.env.AGENT_INTERNAL_TOKEN = oldToken
})

describe('image job-result durable callback replay', () => {
  it('uses one deterministic failure message across initial callback and replay, then acks outbox', async () => {
    const body = {
      pendingActionId: 'image-action',
      status: 'failed',
      error: 'provider_timeout',
    }
    mocks.action!.jobResultEnvelope = terminalEnvelope('failed', {
      error: 'provider_timeout',
    })
    const first = await POST(request(body))
    expect(first.status).toBe(200)
    expect(mocks.action).toMatchObject({ status: 'failed', jobResultPending: false })
    expect(mocks.messages.size).toBe(1)
    expect(mocks.messageUpsert).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { clientRequestId: 'job-result:image:image-action' },
      create: expect.objectContaining({
        content: [{ type: 'text', text: expect.stringContaining('provider_timeout') }],
      }),
    }))

    // Simulate the worker retrying its durable receipt after losing the first
    // HTTP acknowledgement. The same action/message/checkpoint are reconciled.
    mocks.action!.jobResultPending = true
    const replay = await POST(request(body))
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ ok: true, idempotent: true, status: 'failed' })
    expect(mocks.messages.size).toBe(1)
    expect(mocks.messageUpsert).toHaveBeenCalledTimes(2)
    expect(mocks.writeCheckpoint).toHaveBeenCalledTimes(2)
    expect(mocks.action!.jobResultPending).toBe(false)
  })

  it('reconciles an executed image file_ref before clearing the durable outbox', async () => {
    mocks.action = imageAction({
      status: 'executed',
      result: { storagePath: 'generated/final.png' },
      jobResultPending: true,
      jobResultEnvelope: terminalEnvelope('success', {
        data: { storagePath: 'generated/final.png' },
      }),
    })
    const response = await POST(request({
      pendingActionId: 'image-action',
      status: 'success',
      data: { storagePath: 'generated/final.png' },
    }))
    expect(response.status).toBe(200)
    expect(mocks.messageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { clientRequestId: 'job-result:image:image-action' },
      create: expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'file_ref', path: 'generated/final.png' }),
        ]),
      }),
    }))
    expect(mocks.workflowSync).toHaveBeenCalledWith('image-action', 'worker')
    expect(mocks.action.jobResultPending).toBe(false)
  })

  it('leaves the outbox pending when content-pipeline delivery cannot reconcile', async () => {
    mocks.action = imageAction({
      status: 'executed',
      payload: {
        conversationId: 'conversation-1',
        contentPipeline: { gate1Id: 'gate-1' },
      },
      result: { storagePath: 'generated/pipeline.png' },
      jobResultPending: true,
      jobResultEnvelope: terminalEnvelope('success', {
        data: { storagePath: 'generated/pipeline.png' },
      }),
    })
    mocks.pipelineComplete.mockRejectedValueOnce(new Error('pipeline store unavailable'))
    const response = await POST(request({
      pendingActionId: 'image-action',
      status: 'success',
      data: { storagePath: 'generated/pipeline.png' },
    }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'content_pipeline_reconcile_failed' })
    expect(mocks.action.jobResultPending).toBe(true)
  })

  it('fast-acks an already-acknowledged terminal image without rerunning effects', async () => {
    mocks.action = imageAction({
      status: 'executed',
      result: { storagePath: 'generated/already-delivered.png' },
      jobResultPending: false,
    })
    const response = await POST(request({
      pendingActionId: 'image-action',
      status: 'success',
      data: { storagePath: 'generated/already-delivered.png' },
    }))
    expect(response.status).toBe(200)
    expect(mocks.messageUpsert).not.toHaveBeenCalled()
    expect(mocks.workflowSync).not.toHaveBeenCalled()
  })

  it('uses the durable success envelope instead of a stale failed callback body', async () => {
    mocks.action = imageAction({
      status: 'approved',
      jobResultPending: true,
      jobResultEnvelope: terminalEnvelope('success', {
        data: { storagePath: 'generated/canonical-success.png' },
      }),
    })
    const response = await POST(request({
      pendingActionId: 'image-action',
      status: 'failed',
      error: 'late_queue_failure',
    }))
    expect(response.status).toBe(200)
    expect(mocks.action).toMatchObject({ status: 'executed', jobResultPending: false })
    expect(mocks.messageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'file_ref', path: 'generated/canonical-success.png' }),
        ]),
      }),
    }))
  })

  it('leases terminal replay so concurrent callbacks run image effects once', async () => {
    mocks.action = imageAction({
      status: 'executed',
      jobResultPending: true,
      jobResultClaimedAt: null,
      jobResultEnvelope: terminalEnvelope('success', {
        data: { storagePath: 'generated/concurrent.png' },
      }),
      result: { storagePath: 'generated/concurrent.png' },
    })
    let releaseWorkflow: () => void = () => {}
    mocks.workflowSync.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseWorkflow = resolve }))
    const firstPromise = POST(request({ pendingActionId: 'image-action', status: 'success' }))
    await vi.waitFor(() => expect(mocks.workflowSync).toHaveBeenCalledTimes(1))
    const second = await POST(request({ pendingActionId: 'image-action', status: 'success' }))
    expect(second.status).toBe(409)
    await expect(second.json()).resolves.toMatchObject({ error: 'image_reconciliation_in_progress' })
    releaseWorkflow()
    const first = await firstPromise
    expect(first.status).toBe(200)
    expect(mocks.messageUpsert).toHaveBeenCalledTimes(1)
    expect(mocks.workflowSync).toHaveBeenCalledTimes(1)
  })

  it('cannot overwrite a newer success receipt with an in-flight stale failure', async () => {
    const failure = terminalEnvelope('failed', { error: 'provider_timeout' })
    const success = terminalEnvelope('success', {
      data: { storagePath: 'generated/race-winner.png' },
    })
    mocks.action = imageAction({
      status: 'approved',
      jobResultPending: true,
      jobResultEnvelope: failure,
    })
    mocks.beforeTerminalCas.mockImplementationOnce(() => {
      mocks.action!.jobResultEnvelope = success
      mocks.action!.jobResultPending = true
    })

    const response = await POST(request({
      pendingActionId: 'image-action',
      status: 'failed',
      error: 'provider_timeout',
    }))

    expect(response.status).toBe(503)
    expect(mocks.action).toMatchObject({
      status: 'approved',
      jobResultPending: true,
      jobResultEnvelope: success,
    })
    expect(mocks.messageUpsert).not.toHaveBeenCalled()
  })

  it('upgrades a durable failure to paid success and replaces the same failure bubble', async () => {
    const failure = terminalEnvelope('failed', { error: 'provider_timeout' })
    mocks.action = imageAction({
      status: 'approved',
      jobResultPending: true,
      jobResultEnvelope: failure,
    })
    const failed = await POST(request({
      pendingActionId: 'image-action',
      status: 'failed',
      error: 'provider_timeout',
    }))
    expect(failed.status).toBe(200)
    expect(mocks.action!.status).toBe('failed')
    expect(mocks.messages.size).toBe(1)

    const success = terminalEnvelope('success', {
      data: { storagePath: 'generated/recovered-paid.png' },
    })
    mocks.action!.jobResultPending = true
    mocks.action!.jobResultEnvelope = success
    mocks.action!.jobResultClaimedAt = null
    const recovered = await POST(request({
      pendingActionId: 'image-action',
      status: 'success',
      data: { storagePath: 'generated/recovered-paid.png' },
    }))

    expect(recovered.status).toBe(200)
    expect(mocks.action).toMatchObject({ status: 'executed', jobResultPending: false })
    expect(mocks.messages.size).toBe(1)
    expect(mocks.messages.get('job-result:image:image-action')).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'file_ref', path: 'generated/recovered-paid.png' }),
      ]),
    })
  })

  it('adopts an old-worker callback into the outbox before effects and replays after a 503', async () => {
    mocks.action = imageAction({
      status: 'approved',
      jobResultPending: false,
      jobResultEnvelope: null,
    })
    mocks.workflowSync.mockRejectedValueOnce(new Error('workflow store unavailable'))
    const body = {
      pendingActionId: 'image-action',
      status: 'success',
      data: { storagePath: 'generated/legacy-worker.png' },
    }

    const first = await POST(request(body))
    expect(first.status).toBe(503)
    expect(mocks.action).toMatchObject({ status: 'executed', jobResultPending: true })
    expect(mocks.action!.jobResultEnvelope).toMatchObject({
      version: 1,
      status: 'success',
      data: { storagePath: 'generated/legacy-worker.png' },
      receiptId: expect.stringContaining('app-adopted:image-action:'),
    })

    mocks.action!.jobResultClaimedAt = null
    const replay = await POST(request(body))
    expect(replay.status).toBe(200)
    expect(mocks.action!.jobResultPending).toBe(false)
    expect(mocks.messages.size).toBe(1)
  })

  it('does not acknowledge a stale claimed failure after a newer success receipt arrives', async () => {
    const failure = terminalEnvelope('failed', { error: 'first_failure' })
    const success = terminalEnvelope('success', {
      data: { storagePath: 'generated/newer-success.png' },
    })
    mocks.action = imageAction({
      status: 'failed',
      result: { error: 'first_failure' },
      jobResultPending: true,
      jobResultClaimedAt: null,
      jobResultEnvelope: failure,
    })
    mocks.workflowSync.mockImplementationOnce(async () => {
      mocks.action!.jobResultEnvelope = success
      mocks.action!.jobResultPending = true
      mocks.action!.jobResultClaimedAt = null
    })

    const stale = await POST(request({
      pendingActionId: 'image-action',
      status: 'failed',
      error: 'first_failure',
    }))

    expect(stale.status).toBe(503)
    await expect(stale.json()).resolves.toMatchObject({ error: 'image_result_receipt_changed' })
    expect(mocks.action).toMatchObject({
      jobResultPending: true,
      jobResultEnvelope: success,
    })
  })
})
