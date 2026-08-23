import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Dropped `Continue` HTTP response → persisted source id → cold retry.
 *
 * The audited failure mode: the owner taps Continue, the response never lands
 * (app backgrounded / network drop), and the retry after a cold reload starts a
 * SECOND execution — or falls back to a generic history "Continue" that reruns
 * an unrelated prompt.
 *
 * Here the route runs for real, and so does the durable binding CAS: only the
 * database is in memory. The proof is structural — one AgentTurn row, exactly
 * one execution claim, cursor -1, and no owner prompt row of any kind.
 */

const TASK_ID = 'open-task-seo-1'
const CONVERSATION_ID = '9598d574-4587-4449-abc2-7c6ba47407f2'

/** Minimal in-memory Prisma for the tables the binding CAS actually touches. */
const database = vi.hoisted(() => {
  type Turn = {
    id: string
    conversationId: string
    requestId: string | null
    continuationBinding: unknown
    continuationExecutionClaimedAt: Date | null
    status: string
    executionMode: string | null
    instructionOrigin: string | null
    versions: unknown
  }
  const state = {
    turns: [] as Turn[],
    openTasks: [] as Array<Record<string, unknown>>,
    workflows: [] as Array<Record<string, unknown>>,
    /** Any row here would be an owner prompt the retry invented. */
    messages: [] as Array<Record<string, unknown>>,
    turnSeq: 0,
  }
   
  const matches = (row: any, where: any): boolean => {
    for (const [key, expected] of Object.entries(where ?? {})) {
      const actual = row?.[key]
      if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
        const clause = expected as Record<string, unknown>
        if ('not' in clause && actual === clause.not) return false
        if ('in' in clause && !(clause.in as unknown[]).includes(actual)) return false
        continue
      }
      if (expected === null) { if (actual != null) return false; continue }
      if (actual !== expected) return false
    }
    return true
  }
  const collection = <T extends Record<string, unknown>>(rows: () => T[], onCreate?: (data: T) => T) => ({
     
    findUnique: async ({ where }: any) => rows().find((row) => matches(row, where)) ?? null,
     
    findFirst: async ({ where }: any) => rows().find((row) => matches(row, where)) ?? null,
     
    findMany: async ({ where }: any = {}) => rows().filter((row) => matches(row, where ?? {})),
     
    updateMany: async ({ where, data }: any) => {
      const hit = rows().filter((row) => matches(row, where))
      for (const row of hit) Object.assign(row, data)
      return { count: hit.length }
    },
     
    update: async ({ where, data }: any) => {
      const row = rows().find((candidate) => matches(candidate, where))
      if (row) Object.assign(row, data)
      return row ?? null
    },
     
    create: async ({ data }: any) => {
      const created = (onCreate ? onCreate(data) : data) as T
      rows().push(created)
      return created
    },
     
    upsert: async ({ where, update }: any) => {
      const row = rows().find((candidate) => matches(candidate, where))
      if (row) Object.assign(row, update)
      return row ?? null
    },
    deleteMany: async () => ({ count: 0 }),
    count: async () => rows().length,
  })

  const client = {
    agentTurn: collection(() => state.turns, (data) => {
      state.turnSeq += 1
      if (data.requestId && state.turns.some((row) => row.requestId === data.requestId)) {
        const conflict = new Error('Unique constraint failed') as Error & { code?: string }
        conflict.code = 'P2002'
        throw conflict
      }
      return {
        id: `turn-${state.turnSeq}`,
        conversationId: '',
        requestId: null,
        continuationBinding: null,
        continuationExecutionClaimedAt: null,
        status: 'running',
        executionMode: null,
        instructionOrigin: null,
        versions: null,
        ...(data as Record<string, unknown>),
      }
       
    }) as any,
    agentOpenTask: collection(() => state.openTasks),
    workflowRun: collection(() => state.workflows),
    agentMessage: collection(() => state.messages),
    agentPendingAction: collection(() => []),
    agentPlanStep: collection(() => []),
    agentPlan: collection(() => []),
    agentArtifactDeliveryOutbox: collection(() => []),
     
    $transaction: async (arg: any) => (typeof arg === 'function' ? arg(client) : []),
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
  }
  return { state, client }
})

vi.mock('@/lib/prisma', () => ({ prisma: database.client, default: database.client }))
vi.mock('next-auth', () => ({ getServerSession: async () => ({ user: { id: 'owner-1', role: 'OWNER' } }) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: () => true }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/agent-internal-auth', () => ({
  extractBearerToken: () => null,
  verifyAgentInternalToken: () => false,
}))
vi.mock('@/agent/lib/open-task', () => ({
  listOpenTasks: async () => [],
  getOpenTask: async () => null,
  markRunning: async () => {},
  resolveOpenTask: async () => null,
}))
vi.mock('@/agent/lib/turn-status', () => ({
  getTurnSnapshot: async (turnId: string) => {
    const row = database.state.turns.find((turn) => turn.id === turnId)
    return row
      ? {
          id: row.id,
          conversationId: row.conversationId,
          status: row.status,
          // A live executor may already have written rows; the route still
          // clamps a Continue descriptor to a full replay.
          lastSeq: 12,
          assistantMessageId: null,
        }
      : null
  },
}))

const enqueue = vi.hoisted(() => ({ calls: 0 }))

// Real binding CAS, real claim — only the queue hop is replaced.
vi.mock('@/agent/lib/approval-continuation', async () => {
  const binding = await import('@/agent/lib/continuation-binding')
  return {
     
    enqueueAgentContinuation: async (opts: any) => {
      enqueue.calls += 1
      const bound = await binding.bindContinuationTurn({
        binding: opts.binding,
        preferredTurnId: opts.turnId,
        executionMode: 'inline',
      })
      const claim = await binding.claimContinuationExecution({
        conversationId: opts.conversationId,
        turnId: bound.turnId,
        requestId: bound.requestId,
      })
      return {
        outcome: claim.outcome === 'observe' ? 'observe' : 'queued',
        turnId: bound.turnId,
        requestId: bound.requestId,
        status: claim.status ?? 'running',
      }
    },
  }
})

import { POST } from '@/app/api/assistant/open-tasks/route'
import {
  clearPendingOpenTaskContinuation,
  loadPendingOpenTaskContinuation,
  parseOpenTaskContinuation,
  savePendingOpenTaskContinuation,
} from '@/agent/components/AgentOpenTasksChip'

function continueRequest() {
  return new NextRequest('https://alma.test/api/assistant/open-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: TASK_ID, action: 'continue' }),
  })
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

beforeEach(() => {
  database.state.turns = []
  database.state.messages = []
  database.state.turnSeq = 0
  database.state.workflows = [{
    id: 'workflow-seo-1', kind: 'client_seo_batch', status: 'active', stateVersion: 6,
    pendingActionId: null, conversationId: CONVERSATION_ID,
  }]
  database.state.openTasks = [{
    id: TASK_ID,
    businessId: 'ALMA_LIFESTYLE',
    conversationId: CONVERSATION_ID,
    kind: 'chat_followup',
    status: 'open',
    workflowRunId: 'workflow-seo-1',
    pendingActionId: null,
    resumeNote: 'PRIVATE SERVER DIRECTIVE — resume the SEO audit',
  }]
  enqueue.calls = 0
  process.env.AGENT_SOURCE_BOUND_CONTINUATIONS = 'on'
})

describe('dropped Continue response → persisted source id → cold retry', () => {
  it('creates one DB turn and one execution claim across the lost response and the retry', async () => {
    const storage = memoryStorage()

    // 1) The client persists the SOURCE id before the POST, so a lost response
    //    is recoverable without knowing any turn id.
    savePendingOpenTaskContinuation(storage, { openTaskId: TASK_ID, conversationId: CONVERSATION_ID })

    // 2) First Continue. The response body is produced … and dropped.
    const first = await POST(continueRequest())
    // 202 = the exact turn is still running (the status code tracks the turn,
    // not whether this request started it).
    expect(first.status).toBe(202)
    const firstBody = await first.json()
    expect(firstBody).toMatchObject({ ok: true, action: 'continue', conversationId: CONVERSATION_ID })
    const turnId = firstBody.turnId as string
    expect(database.state.turns).toHaveLength(1)
    expect(database.state.turns[0].continuationExecutionClaimedAt).not.toBeNull()
    // The source moved open → running under the same claim transaction.
    expect(database.state.openTasks[0].status).toBe('running')

    // 3) Cold reload. Only the persisted SOURCE id survives.
    const pending = loadPendingOpenTaskContinuation(storage)
    expect(pending).toEqual({ openTaskId: TASK_ID, conversationId: CONVERSATION_ID })

    // 4) The retry replays the exact immutable binding.
    const second = await POST(continueRequest())
    // Same still-running turn, so the same code — and, decisively, the same id.
    expect(second.status).toBe(202)
    const secondBody = await second.json()

    expect(secondBody.turnId).toBe(turnId)
    // Cursor is a full replay: the client applies every durable row itself.
    expect(secondBody.lastSeq).toBe(-1)
    expect(parseOpenTaskContinuation(secondBody, CONVERSATION_ID, TASK_ID)).toEqual({
      openTaskId: TASK_ID,
      conversationId: CONVERSATION_ID,
      turnId,
      lastSeq: -1,
      status: secondBody.status,
    })

    // ONE turn row, ONE execution claim, and no invented owner prompt.
    expect(database.state.turns).toHaveLength(1)
    expect(database.state.turns[0].requestId)
      .toBe(`continuation:v1:open_task:open_task:${TASK_ID}:resume_requested`)
    expect(database.state.messages).toEqual([])
    // The retry did not enqueue a second execution: the route replayed instead.
    expect(enqueue.calls).toBe(1)

    // 5) Once the exact turn is attached again, the recovery hint is released —
    //    and only for this source.
    clearPendingOpenTaskContinuation(storage, 'open-task-other')
    expect(loadPendingOpenTaskContinuation(storage)).not.toBeNull()
    clearPendingOpenTaskContinuation(storage, TASK_ID)
    expect(loadPendingOpenTaskContinuation(storage)).toBeNull()
  })

  it('replays the same turn instead of rerunning after the source is already resolved', async () => {
    const first = await POST(continueRequest())
    const turnId = (await first.json()).turnId as string

    // The executor finished and resolved the source while the response was lost.
    database.state.openTasks[0].status = 'done'
    database.state.turns[0].status = 'done'

    const retry = await POST(continueRequest())
    expect(retry.status).toBe(200)
    const body = await retry.json()
    expect(body).toMatchObject({ ok: true, action: 'continue', turnId, lastSeq: -1, status: 'done' })
    expect(database.state.turns).toHaveLength(1)
    expect(database.state.messages).toEqual([])
    expect(enqueue.calls).toBe(1)
  })

  it('refuses to start anything when the source was never bound and is already terminal', async () => {
    database.state.openTasks[0].status = 'done'
    const response = await POST(continueRequest())
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: 'open_task_already_resolved' })
    expect(database.state.turns).toEqual([])
    expect(enqueue.calls).toBe(0)
  })
})
