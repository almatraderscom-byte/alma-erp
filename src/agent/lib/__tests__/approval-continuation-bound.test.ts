import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  kvFind: vi.fn(),
  bind: vi.fn(),
  claim: vi.fn(),
  build: vi.fn(),
  enqueue: vi.fn(),
  runOwnerTurn: vi.fn(),
  finalize: vi.fn(),
  linkAssistant: vi.fn(),
  trace: vi.fn(),
  unanswered: vi.fn(),
  emitted: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/prisma', () => ({ prisma: { agentKvSetting: { findUnique: mocks.kvFind } } }))
vi.mock('@/agent/lib/turn-status', () => ({
  createTurn: vi.fn(),
  finalizeTurnIfRunning: mocks.finalize,
  linkTurnAssistantMessage: mocks.linkAssistant,
}))
vi.mock('@/agent/lib/turn-queue', () => ({
  buildTurnJobData: mocks.build,
  enqueueTurnJob: mocks.enqueue,
  isTurnHandoffConfigured: () => true,
}))
vi.mock('@/agent/lib/turn-stage-trace', () => ({ traceTurnStage: mocks.trace }))
vi.mock('@/agent/lib/turn-events', () => ({
  createTurnEventPublisher: () => ({
    emit: (event: Record<string, unknown>) => mocks.emitted.push(event),
    finish: vi.fn(async () => mocks.emitted.length - 1),
    durabilityHoles: () => 0,
  }),
}))
vi.mock('@/agent/lib/job-delivery', () => ({ hasUnansweredAskCard: mocks.unanswered }))
vi.mock('@/agent/lib/models/run-owner-turn', () => ({ runOwnerTurn: mocks.runOwnerTurn }))
vi.mock('@/agent/lib/continuation-binding', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('@/agent/lib/continuation-binding')>()
  return {
    ...original,
    sourceBoundContinuationsEnabled: () => true,
    bindContinuationTurn: mocks.bind,
    claimContinuationExecution: mocks.claim,
  }
})

import {
  enqueueAgentContinuation,
  runContinuationInline,
} from '@/agent/lib/approval-continuation'
import type { ContinuationBindingV1 } from '@/agent/lib/continuation-binding'

const binding: ContinuationBindingV1 = {
  v: 1,
  origin: 'job_result',
  source: { kind: 'pending_action', id: 'action-1' },
  conversationId: 'conv-1',
  domain: 'seo',
  event: 'artifact_delivered',
  directive: { kind: 'seo_artifact_delivered', version: 1 },
  expected: { sourceStatus: ['executed'], sourceType: 'seo_audit', deliveryState: 'delivered' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.emitted.length = 0
  mocks.kvFind.mockImplementation(async ({ where }: { where: { key: string } }) => (
    where.key === 'worker_heartbeat_at'
      ? { value: new Date().toISOString() }
      : { value: 'on' }
  ))
  mocks.unanswered.mockResolvedValue(false)
  mocks.bind.mockResolvedValue({
    turnId: 'turn-bound',
    requestId: 'continuation:v1:job_result:pending_action:action-1:artifact_delivered',
    status: 'running',
    created: true,
  })
  mocks.build.mockImplementation((turnId, conversationId, body) => ({ turnId, conversationId, ...body }))
  mocks.enqueue.mockResolvedValue('turn-turn-bound')
  mocks.finalize.mockResolvedValue(undefined)
  mocks.claim.mockResolvedValue({
    outcome: 'claimed',
    binding,
    directive: '[server rendered directive]',
    status: 'running',
  })
  mocks.runOwnerTurn.mockImplementation(async function* () {
    yield { type: 'text_delta', delta: 'done' }
    yield { type: 'done', messageId: 'message-1' }
  })
})

describe('source-bound continuation transport', () => {
  it('queues only the deterministic turn/request references and ignores caller prose', async () => {
    const result = await enqueueAgentContinuation({
      conversationId: 'conv-1',
      binding,
      message: 'tampered caller prose',
      force: true,
    })

    expect(mocks.build).toHaveBeenCalledWith('turn-bound', 'conv-1', {
      internalControl: true,
      continuationRequestId: 'continuation:v1:job_result:pending_action:action-1:artifact_delivered',
    })
    expect(mocks.build.mock.calls[0][2]).not.toHaveProperty('message')
    expect(result).toMatchObject({ outcome: 'queued', turnId: 'turn-bound' })
  })

  it('inline execution claims once, passes the exact turn, and uses only the server directive', async () => {
    await runContinuationInline({
      conversationId: 'conv-1',
      continuationRequestId: 'continuation:v1:job_result:pending_action:action-1:artifact_delivered',
    }, 'turn-bound')

    expect(mocks.claim).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      turnId: 'turn-bound',
      requestId: 'continuation:v1:job_result:pending_action:action-1:artifact_delivered',
    })
    expect(mocks.runOwnerTurn).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      turnId: 'turn-bound',
      continuation: true,
      projectSystemInstructions: '[server rendered directive]',
    }))
  })

  it('an already-claimed duplicate observes without running or posting a silence note', async () => {
    mocks.claim.mockResolvedValueOnce({ outcome: 'observe', binding, status: 'running' })
    const result = await runContinuationInline({
      conversationId: 'conv-1',
      continuationRequestId: 'continuation:v1:job_result:pending_action:action-1:artifact_delivered',
    }, 'turn-bound')
    expect(result).toMatchObject({ outcome: 'observe' })
    expect(mocks.runOwnerTurn).not.toHaveBeenCalled()
  })
})
