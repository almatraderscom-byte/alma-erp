import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  isSystemOwner: vi.fn(),
  taskFindUnique: vi.fn(),
  workflowFindUnique: vi.fn(),
  pendingFindMany: vi.fn(),
  listOpenTasks: vi.fn(),
  getOpenTask: vi.fn(),
  markRunning: vi.fn(),
  resolveOpenTask: vi.fn(),
  findExistingBoundContinuationTurn: vi.fn(),
  settleUnclaimedOpenTaskContinuation: vi.fn(),
  enqueueAgentContinuation: vi.fn(),
  getTurnSnapshot: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: mocks.isSystemOwner }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/agent-internal-auth', () => ({
  extractBearerToken: () => null,
  verifyAgentInternalToken: () => false,
}))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentOpenTask: { findUnique: mocks.taskFindUnique },
    workflowRun: { findUnique: mocks.workflowFindUnique },
    agentPendingAction: { findMany: mocks.pendingFindMany },
  },
}))
vi.mock('@/agent/lib/open-task', () => ({
  listOpenTasks: mocks.listOpenTasks,
  getOpenTask: mocks.getOpenTask,
  markRunning: mocks.markRunning,
  resolveOpenTask: mocks.resolveOpenTask,
}))
vi.mock('@/agent/lib/approval-continuation', () => ({
  enqueueAgentContinuation: mocks.enqueueAgentContinuation,
}))
vi.mock('@/agent/lib/continuation-binding', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/agent/lib/continuation-binding')>()
  return {
    ...original,
    findExistingBoundContinuationTurn: mocks.findExistingBoundContinuationTurn,
    settleUnclaimedOpenTaskContinuation: mocks.settleUnclaimedOpenTaskContinuation,
  }
})
vi.mock('@/agent/lib/turn-status', () => ({ getTurnSnapshot: mocks.getTurnSnapshot }))

import { GET, POST } from '../route'

function request(id = 'open-task-1', action = 'continue') {
  return new NextRequest('https://alma.test/api/assistant/open-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action }),
  })
}

const task = {
  id: 'open-task-1',
  businessId: 'ALMA_LIFESTYLE',
  conversationId: 'conversation-1',
  kind: 'chat_followup',
  status: 'open',
  resumeNote: 'PRIVATE SERVER DIRECTIVE — never return this as owner text',
  workflowRunId: 'workflow-1',
  title: 'SEO audit continue',
}

describe('POST /api/assistant/open-tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getServerSession.mockResolvedValue({ user: { id: 'owner-1', role: 'OWNER' } })
    mocks.isSystemOwner.mockReturnValue(true)
    mocks.taskFindUnique.mockResolvedValue(task)
    mocks.getOpenTask.mockResolvedValue(task)
    mocks.workflowFindUnique.mockResolvedValue({
      id: 'workflow-1', kind: 'client_seo_batch', status: 'active', stateVersion: 6,
    })
    mocks.findExistingBoundContinuationTurn.mockResolvedValue(null)
    mocks.settleUnclaimedOpenTaskContinuation.mockResolvedValue({
      settled: true,
      status: 'canceled',
      executionClaimed: false,
      sourceStatus: 'done',
    })
    mocks.enqueueAgentContinuation.mockResolvedValue({
      outcome: 'queued', turnId: 'turn-bound-1', requestId: 'continuation:open_task:open-task-1',
      status: 'running',
    })
    mocks.getTurnSnapshot.mockResolvedValue({
      id: 'turn-bound-1', conversationId: 'conversation-1', status: 'running',
      lastSeq: 7, assistantMessageId: null,
    })
    mocks.resolveOpenTask.mockResolvedValue(task)
    mocks.listOpenTasks.mockResolvedValue([])
    mocks.pendingFindMany.mockResolvedValue([])
  })

  it('does not expose the private resume directive in the task-list projection', async () => {
    mocks.listOpenTasks.mockResolvedValue([{
      ...task,
      ageMinutes: 3,
    }])
    const response = await GET(new NextRequest(
      'https://alma.test/api/assistant/open-tasks?conversationId=conversation-1',
    ))

    expect(response.status).toBe(200)
    const json = await response.json() as { tasks: Array<Record<string, unknown>> }
    expect(json.tasks).toEqual([expect.objectContaining({
      id: 'open-task-1',
      kind: 'chat_followup',
      title: 'SEO audit continue',
      note: '',
    })])
    expect(JSON.stringify(json)).not.toContain(task.resumeNote)
  })

  it('binds the exact open-task source and returns only an attachable turn descriptor', async () => {
    const response = await POST(request())

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: 'continue',
      conversationId: 'conversation-1',
      turnId: 'turn-bound-1',
      lastSeq: -1,
      status: 'running',
    })
    expect(mocks.enqueueAgentContinuation).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      binding: expect.objectContaining({
        v: 1,
        origin: 'open_task',
        source: { kind: 'open_task', id: 'open-task-1' },
        conversationId: 'conversation-1',
        domain: 'seo',
        event: 'resume_requested',
        directive: { kind: 'open_task_resume', version: 1 },
        workflowRunId: 'workflow-1',
        expected: {
          sourceStatus: ['open'],
          sourceType: 'chat_followup',
          workflowKind: 'client_seo_batch',
          workflowStateVersion: 6,
        },
      }),
    }))
    expect(mocks.markRunning).not.toHaveBeenCalled()
  })

  it('observes the same bound turn on a duplicate Continue instead of creating owner text', async () => {
    mocks.taskFindUnique.mockResolvedValue({ ...task, status: 'running' })
    mocks.getOpenTask.mockResolvedValue({ ...task, status: 'running' })
    mocks.findExistingBoundContinuationTurn.mockResolvedValue({
      turnId: 'turn-bound-1',
      requestId: 'continuation:open_task:open-task-1', status: 'running',
      created: false,
      executionClaimed: true,
      binding: {
        v: 1, origin: 'open_task', source: { kind: 'open_task', id: 'open-task-1' },
        conversationId: 'conversation-1', domain: 'seo', event: 'resume_requested',
        directive: { kind: 'open_task_resume', version: 1 },
        expected: { sourceStatus: ['open'], sourceType: 'chat_followup' },
      },
    })

    const response = await POST(request())
    const json = await response.json() as Record<string, unknown>

    expect(response.status).toBe(202)
    expect(json.turnId).toBe('turn-bound-1')
    expect(json).not.toHaveProperty('resumeNote')
    expect(JSON.stringify(json)).not.toContain(task.resumeNote)
    expect(mocks.markRunning).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentContinuation).not.toHaveBeenCalled()
  })

  it('returns a retryable failure without pre-marking the task running when no executor accepted it', async () => {
    mocks.enqueueAgentContinuation.mockResolvedValue({
      outcome: 'deferred', turnId: 'turn-bound-1',
      requestId: 'continuation:open_task:open-task-1', status: 'running',
    })

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'continuation_deferred',
      openTaskId: 'open-task-1',
    })
    expect(mocks.markRunning).not.toHaveBeenCalled()
  })

  it('returns the exact terminal error descriptor after an at-most-once execution fails', async () => {
    mocks.enqueueAgentContinuation.mockResolvedValue({
      outcome: 'failed', turnId: 'turn-bound-1',
      requestId: 'continuation:open_task:open-task-1', status: 'error',
    })
    mocks.getTurnSnapshot.mockResolvedValue({
      id: 'turn-bound-1', conversationId: 'conversation-1', status: 'error',
      lastSeq: 11, assistantMessageId: 'assistant-error-1',
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: 'continue',
      conversationId: 'conversation-1',
      turnId: 'turn-bound-1',
      lastSeq: -1,
      status: 'error',
    })
  })

  it('returns the same exact turn after a lost response even when the source is now terminal', async () => {
    mocks.taskFindUnique.mockResolvedValue({ ...task, status: 'done' })
    mocks.findExistingBoundContinuationTurn.mockResolvedValue({
      turnId: 'turn-bound-1',
      requestId: 'continuation:v1:open_task:open_task:open-task-1:resume_requested',
      status: 'done',
      created: false,
      executionClaimed: true,
      binding: {
        v: 1,
        origin: 'open_task',
        source: { kind: 'open_task', id: 'open-task-1' },
        conversationId: 'conversation-1',
        domain: 'seo',
        event: 'resume_requested',
        directive: { kind: 'open_task_resume', version: 1 },
        expected: { sourceStatus: ['open', 'running'], sourceType: 'chat_followup' },
      },
    })
    mocks.getTurnSnapshot.mockResolvedValue({
      id: 'turn-bound-1', conversationId: 'conversation-1', status: 'done',
      lastSeq: 214, assistantMessageId: 'assistant-exact-1',
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: 'continue',
      conversationId: 'conversation-1',
      turnId: 'turn-bound-1',
      lastSeq: -1,
      status: 'done',
    })
    expect(mocks.findExistingBoundContinuationTurn).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      origin: 'open_task',
      source: { kind: 'open_task', id: 'open-task-1' },
      event: 'resume_requested',
    })
    expect(mocks.workflowFindUnique).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentContinuation).not.toHaveBeenCalled()
  })

  it('does not create or execute a turn for an unclaimed terminal source', async () => {
    mocks.taskFindUnique.mockResolvedValue({ ...task, status: 'done' })
    mocks.findExistingBoundContinuationTurn.mockResolvedValue(null)

    const response = await POST(request())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'open_task_already_resolved',
      status: 'done',
    })
    expect(mocks.enqueueAgentContinuation).not.toHaveBeenCalled()
  })

  it('does not adopt an unbound running source as a new execution', async () => {
    mocks.taskFindUnique.mockResolvedValue({ ...task, status: 'running' })
    mocks.findExistingBoundContinuationTurn.mockResolvedValue(null)

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(mocks.enqueueAgentContinuation).not.toHaveBeenCalled()
  })

  it('retries the same deferred unclaimed turn when its source is still open', async () => {
    const storedBinding = {
      v: 1 as const,
      origin: 'open_task' as const,
      source: { kind: 'open_task' as const, id: 'open-task-1' },
      conversationId: 'conversation-1',
      domain: 'seo' as const,
      event: 'resume_requested' as const,
      directive: { kind: 'open_task_resume' as const, version: 1 as const },
      expected: { sourceStatus: ['open'], sourceType: 'chat_followup' },
    }
    mocks.findExistingBoundContinuationTurn.mockResolvedValue({
      turnId: 'turn-deferred-1',
      requestId: 'continuation:v1:open_task:open_task:open-task-1:resume_requested',
      status: 'running',
      created: false,
      executionClaimed: false,
      binding: storedBinding,
    })
    mocks.enqueueAgentContinuation.mockResolvedValue({
      outcome: 'queued', turnId: 'turn-deferred-1',
      requestId: 'continuation:v1:open_task:open_task:open-task-1:resume_requested',
      status: 'running',
    })
    mocks.getTurnSnapshot.mockResolvedValue({
      id: 'turn-deferred-1', conversationId: 'conversation-1', status: 'running',
      lastSeq: -1, assistantMessageId: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(202)
    expect(mocks.enqueueAgentContinuation).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      binding: storedBinding,
      turnId: 'turn-deferred-1',
    }))
    expect(mocks.workflowFindUnique).not.toHaveBeenCalled()
  })

  it('atomically settles an unclaimed existing turn after its source became terminal', async () => {
    mocks.taskFindUnique.mockResolvedValue({ ...task, status: 'done' })
    mocks.findExistingBoundContinuationTurn.mockResolvedValue({
      turnId: 'turn-deferred-1',
      requestId: 'continuation:v1:open_task:open_task:open-task-1:resume_requested',
      status: 'running',
      created: false,
      executionClaimed: false,
      binding: {
        v: 1, origin: 'open_task', source: { kind: 'open_task', id: 'open-task-1' },
        conversationId: 'conversation-1', domain: 'seo', event: 'resume_requested',
        directive: { kind: 'open_task_resume', version: 1 },
        expected: { sourceStatus: ['open'], sourceType: 'chat_followup' },
      },
    })
    mocks.getTurnSnapshot.mockResolvedValue({
      id: 'turn-deferred-1', conversationId: 'conversation-1', status: 'canceled',
      lastSeq: 0, assistantMessageId: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: 'continue',
      conversationId: 'conversation-1',
      turnId: 'turn-deferred-1',
      lastSeq: -1,
      status: 'canceled',
    })
    expect(mocks.settleUnclaimedOpenTaskContinuation).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      turnId: 'turn-deferred-1',
      requestId: 'continuation:v1:open_task:open_task:open-task-1:resume_requested',
    })
    expect(mocks.enqueueAgentContinuation).not.toHaveBeenCalled()
  })

  it('refuses a non-followup source before scheduling any continuation', async () => {
    mocks.taskFindUnique.mockResolvedValue({ ...task, kind: 'approval_pending' })
    mocks.getOpenTask.mockResolvedValue({ ...task, kind: 'approval_pending' })

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(mocks.enqueueAgentContinuation).not.toHaveBeenCalled()
  })

  it('rejects an unknown action instead of treating it as implicit Continue', async () => {
    const response = await POST(request('open-task-1', 'resume-with-prose'))

    expect(response.status).toBe(400)
    expect(mocks.taskFindUnique).not.toHaveBeenCalled()
    expect(mocks.enqueueAgentContinuation).not.toHaveBeenCalled()
  })
})
