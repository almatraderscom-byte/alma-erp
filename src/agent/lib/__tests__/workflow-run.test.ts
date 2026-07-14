import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Phase 4 WorkflowRun service tests — run against an in-memory prisma fake so
 * the REAL transition logic (optimistic versioning, terminal auto-close,
 * reconciliation) executes, not stubs.
 */

type Row = Record<string, unknown>

const { store, nextId, makeModel } = vi.hoisted(() => {
  type HRow = Record<string, unknown>
  const store: { workflowRun: HRow[]; workflowRunEvent: HRow[]; agentOpenTask: HRow[]; agentPendingAction: HRow[] } = {
    workflowRun: [],
    workflowRunEvent: [],
    agentOpenTask: [],
    agentPendingAction: [],
  }

  let idSeq = 0
  const nextId = () => `id_${++idSeq}`

  const matches = (row: HRow, where: HRow): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in (v as HRow)) {
        return ((v as { in: unknown[] }).in).includes(row[k])
      }
      return row[k] === v
    })

  const applyData = (row: HRow, data: HRow): void => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as HRow)) {
        row[k] = ((row[k] as number) ?? 0) + ((v as { increment: number }).increment)
      } else if (v !== undefined) {
        row[k] = v
      }
    }
    row.updatedAt = new Date()
  }

  const stripUndefined = (o: HRow): HRow =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

  const makeModel = (table: HRow[], defaults: () => HRow) => ({
    create: async ({ data }: { data: HRow }) => {
      const row: HRow = { ...defaults(), id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...stripUndefined(data) }
      table.push(row)
      return { ...row }
    },
    findUnique: async ({ where }: { where: HRow }) => {
      const row = table.find((r) => matches(r, where))
      return row ? { ...row } : null
    },
    findFirst: async ({ where }: { where: HRow }) => {
      const rows = table.filter((r) => matches(r, where))
      rows.sort((a, b) => new Date(b.createdAt as Date).getTime() - new Date(a.createdAt as Date).getTime())
      return rows[0] ? { ...rows[0] } : null
    },
    findMany: async ({ where, take }: { where?: HRow; take?: number }) => {
      let rows = where ? table.filter((r) => matches(r, where)) : [...table]
      rows.sort((a, b) => new Date(b.updatedAt as Date).getTime() - new Date(a.updatedAt as Date).getTime())
      if (take) rows = rows.slice(0, take)
      return rows.map((r) => ({ ...r }))
    },
    update: async ({ where, data }: { where: HRow; data: HRow }) => {
      const row = table.find((r) => matches(r, where))
      if (!row) throw new Error('record not found')
      applyData(row, data)
      return { ...row }
    },
    updateMany: async ({ where, data }: { where: HRow; data: HRow }) => {
      const rows = table.filter((r) => matches(r, where))
      for (const row of rows) applyData(row, data)
      return { count: rows.length }
    },
  })

  return { store, nextId, makeModel }
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    workflowRun: makeModel(store.workflowRun, () => ({
      businessId: 'ALMA_LIFESTYLE', status: 'active', state: 'started', stateVersion: 1,
      retryCount: 0, conversationId: null, pendingActionId: null,
      facts: null, nextAllowedTools: null, completedAt: null, leaseUntil: null,
    })),
    workflowRunEvent: makeModel(store.workflowRunEvent, () => ({})),
    agentOpenTask: makeModel(store.agentOpenTask, () => ({ status: 'open' })),
    agentPendingAction: makeModel(store.agentPendingAction, () => ({ status: 'pending' })),
  },
}))

import {
  createWorkflowRun,
  transitionWorkflowRun,
  ensureWorkflowRunForPendingAction,
  syncWorkflowWithPendingAction,
  reconcileConversationWorkflows,
  listActiveWorkflowRuns,
  workflowBlocksApproval,
  buildWorkflowSnapshotNote,
  WorkflowVersionConflictError,
} from '../workflow-run'

beforeEach(() => {
  store.workflowRun.length = 0
  store.workflowRunEvent.length = 0
  store.agentOpenTask.length = 0
  store.agentPendingAction.length = 0
})

describe('WorkflowRun transitions (Phase 4)', () => {
  it('create → transition bumps stateVersion and logs events', async () => {
    const run = await createWorkflowRun({ conversationId: 'c1', kind: 'social', goal: 'FB post' })
    expect(run.status).toBe('active')
    expect(run.stateVersion).toBe(1)

    const after = await transitionWorkflowRun({
      runId: run.id, expectedVersion: 1, toStatus: 'waiting_owner', toState: 'awaiting_approval', cause: 'turn',
    })
    expect(after.status).toBe('waiting_owner')
    expect(after.stateVersion).toBe(2)
    expect(store.workflowRunEvent.filter((e) => e.workflowRunId === run.id)).toHaveLength(2) // created + transition
  })

  it('optimistic conflict: stale version is rejected (no double execution)', async () => {
    const run = await createWorkflowRun({ conversationId: 'c1', kind: 'ads', goal: 'launch' })
    await transitionWorkflowRun({ runId: run.id, expectedVersion: 1, toState: 'step2', cause: 'turn' })
    await expect(
      transitionWorkflowRun({ runId: run.id, expectedVersion: 1, toState: 'step2-again', cause: 'turn' }),
    ).rejects.toThrow(WorkflowVersionConflictError)
  })

  it('terminal transition auto-closes linked open-task chips + stamps completedAt', async () => {
    const run = await createWorkflowRun({ conversationId: 'c1', kind: 'browser', goal: 'carousel task' })
    store.agentOpenTask.push({ id: nextId(), workflowRunId: run.id, status: 'open', createdAt: new Date(), updatedAt: new Date() })

    await transitionWorkflowRun({ runId: run.id, expectedVersion: 1, toStatus: 'done', toState: 'executed', cause: 'approval' })

    const row = store.workflowRun.find((r) => r.id === run.id)
    expect(row?.completedAt).toBeTruthy()
    expect(store.agentOpenTask[0].status).toBe('done')
    expect((await listActiveWorkflowRuns('c1'))).toHaveLength(0)
  })
})

describe('auto-create from staged cards', () => {
  it('ensureWorkflowRunForPendingAction is idempotent and stamps the card', async () => {
    store.agentPendingAction.push({ id: 'card1', status: 'pending', createdAt: new Date(), updatedAt: new Date() })
    const a = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'card1', conversationId: 'c1', kind: 'social', goal: 'FB post 720',
    })
    const b = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'card1', conversationId: 'c1', kind: 'social', goal: 'FB post 720',
    })
    expect(a.id).toBe(b.id)
    expect(a.status).toBe('waiting_owner')
    expect(store.workflowRun).toHaveLength(1)
    expect(store.agentPendingAction[0].workflowRunId).toBe(a.id)
  })
})

describe('approval sync + reconciliation', () => {
  async function seed(cardStatus: string) {
    store.agentPendingAction.push({ id: 'cardX', status: 'pending', type: 'fb_post', createdAt: new Date(), updatedAt: new Date() })
    const run = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'cardX', conversationId: 'c9', kind: 'social', goal: 'post',
    })
    store.agentPendingAction[0].status = cardStatus
    return run
  }

  it('executed card → run done with proof', async () => {
    const run = await seed('executed')
    await syncWorkflowWithPendingAction('cardX', 'approval')
    const row = store.workflowRun.find((r) => r.id === run.id)
    expect(row?.status).toBe('done')
    expect((row?.lastProof as Row)?.ref).toBe('cardX')
  })

  it('rejected card → run cancelled', async () => {
    const run = await seed('rejected')
    await syncWorkflowWithPendingAction('cardX', 'approval')
    expect(store.workflowRun.find((r) => r.id === run.id)?.status).toBe('cancelled')
  })

  it('approved (queued) card → run waiting_worker', async () => {
    const run = await seed('approved')
    await syncWorkflowWithPendingAction('cardX', 'approval')
    expect(store.workflowRun.find((r) => r.id === run.id)?.status).toBe('waiting_worker')
  })

  it('turn-start reconcile lazily closes runs whose cards resolved elsewhere', async () => {
    await seed('executed') // no direct sync call — simulates a per-type route branch
    const remaining = await reconcileConversationWorkflows('c9')
    expect(remaining).toHaveLength(0)
    expect(store.workflowRun[0].status).toBe('done')
  })
})

describe('execution guard (no action against an outdated workflow)', () => {
  it('blocks approval when the linked run is terminal', async () => {
    store.agentPendingAction.push({ id: 'cardZ', status: 'pending', createdAt: new Date(), updatedAt: new Date() })
    const run = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'cardZ', conversationId: 'c2', kind: 'ads', goal: 'campaign',
    })
    await transitionWorkflowRun({ runId: run.id, expectedVersion: run.stateVersion, toStatus: 'cancelled', cause: 'turn' })

    const guard = await workflowBlocksApproval('cardZ')
    expect(guard.blocked).toBe(true)
    expect(guard.reason).toContain('বাতিল')
  })

  it('does not block active runs or unlinked cards (fail-open)', async () => {
    store.agentPendingAction.push({ id: 'cardY', status: 'pending', createdAt: new Date(), updatedAt: new Date() })
    await ensureWorkflowRunForPendingAction({ pendingActionId: 'cardY', conversationId: 'c3', kind: 'social', goal: 'x' })
    expect((await workflowBlocksApproval('cardY')).blocked).toBe(false)
    expect((await workflowBlocksApproval('no_such_card')).blocked).toBe(false)
  })
})

describe('resume snapshot note', () => {
  it('carries kind, goal, step and the continue instruction', async () => {
    const run = await createWorkflowRun({
      conversationId: 'c1', kind: 'browser', goal: 'Meta carousel setup',
      status: 'waiting_owner', state: 'awaiting_login', nextAllowedTools: ['live_browser_look', 'live_browser_act'],
    })
    const note = buildWorkflowSnapshotNote([run])
    expect(note).toContain('Meta carousel setup')
    expect(note).toContain('browser')
    expect(note).toContain('awaiting_login')
    expect(note).toContain('live_browser_look')
    expect(note).toContain('continue')
    expect(buildWorkflowSnapshotNote([])).toBe('')
  })
})
