import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Phase 4 WorkflowRun service tests — run against an in-memory prisma fake so
 * the REAL transition logic (optimistic versioning, terminal auto-close,
 * reconciliation) executes, not stubs.
 */

type Row = Record<string, unknown>

const { store, nextId, makeModel } = vi.hoisted(() => {
  type HRow = Record<string, unknown>
  const store: { workflowRun: HRow[]; workflowRunEvent: HRow[]; agentOpenTask: HRow[]; agentPendingAction: HRow[]; agentAskCard: HRow[] } = {
    workflowRun: [],
    workflowRunEvent: [],
    agentOpenTask: [],
    agentPendingAction: [],
    agentAskCard: [],
  }

  let idSeq = 0
  const nextId = () => `id_${++idSeq}`

  const matches = (row: HRow, where: HRow): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as HRow[]).some((clause) => matches(row, clause))
      if (v && typeof v === 'object' && 'in' in (v as HRow)) {
        return ((v as { in: unknown[] }).in).includes(row[k])
      }
      if (v && typeof v === 'object' && 'lt' in (v as HRow)) {
        return row[k] != null && (row[k] as Date) < ((v as { lt: Date }).lt)
      }
      if (v && typeof v === 'object' && 'gt' in (v as HRow)) {
        return row[k] != null && (row[k] as Date) > ((v as { gt: Date }).gt)
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
    agentAskCard: makeModel(store.agentAskCard, () => ({ status: 'pending' })),
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
  advanceWorkflowOnAskAnswer,
  acquireWorkflowLease,
  releaseWorkflowLease,
  WorkflowVersionConflictError,
} from '../workflow-run'

beforeEach(() => {
  store.workflowRun.length = 0
  store.workflowRunEvent.length = 0
  store.agentOpenTask.length = 0
  store.agentPendingAction.length = 0
  store.agentAskCard.length = 0
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

  it('template runs show the step label and the expected next tool', async () => {
    const run = await createWorkflowRun({
      conversationId: 'c1', kind: 'product_post', goal: '720 পোস্ট',
      status: 'active', state: 'post_draft', facts: { previewConfirmed: true },
      nextAllowedTools: ['post_to_facebook', 'publish_to_instagram'],
    })
    const note = buildWorkflowSnapshotNote([run])
    expect(note).toContain('post_draft')
    expect(note).toContain('পোস্ট কার্ড stage')
    expect(note).toContain('প্রত্যাশিত পরের কাজ: post_to_facebook')
  })
})

// ── Phase 5: workflow templates drive the machine ────────────────────────────

describe('product_post template end-to-end (Phase 5)', () => {
  it('image card → rendering → preview_confirm → ask answer → post card attaches → published', async () => {
    // 1. image_gen card staged → run opens AT the template's creative_approval step
    store.agentPendingAction.push({ id: 'img1', status: 'pending', type: 'image_gen', createdAt: new Date(), updatedAt: new Date() })
    const run = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'img1', conversationId: 'cc', actionType: 'image_gen', kind: 'creative', goal: '720 পোস্ট',
    })
    expect(run.kind).toBe('product_post')
    expect(run.state).toBe('creative_approval')
    expect(run.status).toBe('waiting_owner')
    expect(run.nextAllowedTools).toContain('get_product')

    // 2. owner approves → VPS worker queue → rendering
    store.agentPendingAction[0].status = 'approved'
    await syncWorkflowWithPendingAction('img1', 'approval')
    let row = store.workflowRun.find((r) => r.id === run.id)
    expect(row?.state).toBe('rendering')
    expect(row?.status).toBe('waiting_worker')

    // 3. worker executes → NOT done: the template advances to preview_confirm
    store.agentPendingAction[0].status = 'executed'
    await syncWorkflowWithPendingAction('img1', 'worker')
    row = store.workflowRun.find((r) => r.id === run.id)
    expect(row?.state).toBe('preview_confirm')
    expect(row?.status).toBe('active')
    expect((row?.facts as Row)?.imageGenerated).toBe(true)
    expect((row?.facts as Row)?.previewConfirmed).toBe(false)
    expect(row?.pendingActionId).toBeNull() // slot freed for the post card
    expect(row?.nextAllowedTools).toContain('ask_user')

    // 4. the bound ask-card answer unlocks the post step
    await advanceWorkflowOnAskAnswer(run.id, 'ঠিক আছে, post করো')
    row = store.workflowRun.find((r) => r.id === run.id)
    expect(row?.state).toBe('post_draft')
    expect((row?.facts as Row)?.previewConfirmed).toBe(true)
    expect(row?.nextAllowedTools).toContain('post_to_facebook')

    // 5. fb_post card ATTACHES to the SAME run (no duplicate) at post_approval
    store.agentPendingAction.push({ id: 'post1', status: 'pending', type: 'fb_post', createdAt: new Date(), updatedAt: new Date() })
    const attached = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'post1', conversationId: 'cc', actionType: 'fb_post', kind: 'social', goal: '720 পোস্ট',
    })
    expect(attached.id).toBe(run.id)
    expect(attached.state).toBe('post_approval')
    expect(store.workflowRun).toHaveLength(1)

    // 6. post executes → terminal published_verified with proof
    store.agentPendingAction[1].status = 'executed'
    await syncWorkflowWithPendingAction('post1', 'approval')
    row = store.workflowRun.find((r) => r.id === run.id)
    expect(row?.status).toBe('done')
    expect(row?.state).toBe('published_verified')
    expect((row?.lastProof as Row)?.ref).toBe('post1')
  })

  it('rejected image card falls back to draft_ready (change-flow), not cancelled', async () => {
    store.agentPendingAction.push({ id: 'img2', status: 'pending', type: 'image_gen', createdAt: new Date(), updatedAt: new Date() })
    const run = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'img2', conversationId: 'cd', actionType: 'image_gen', kind: 'creative', goal: 'পোস্ট',
    })
    store.agentPendingAction[0].status = 'rejected'
    await syncWorkflowWithPendingAction('img2', 'approval')
    const row = store.workflowRun.find((r) => r.id === run.id)
    expect(row?.status).toBe('active')
    expect(row?.state).toBe('draft_ready')
  })

  it('a change-request answer at preview_confirm drops back to drafting', async () => {
    const run = await createWorkflowRun({
      conversationId: 'ce', kind: 'product_post', goal: 'পোস্ট',
      state: 'preview_confirm', facts: { imageGenerated: true, previewConfirmed: false },
    })
    await advanceWorkflowOnAskAnswer(run.id, 'অন্য কিছু change চাই')
    const row = store.workflowRun.find((r) => r.id === run.id)
    expect(row?.state).toBe('draft_ready')
    expect((row?.facts as Row)?.previewConfirmed).toBe(false)
  })

  it('reconcile advances an answered bound ask card (Anthropic-path parity)', async () => {
    const run = await createWorkflowRun({
      conversationId: 'cf', kind: 'product_post', goal: 'পোস্ট',
      state: 'preview_confirm', facts: { imageGenerated: true },
    })
    store.agentAskCard.push({
      id: 'ask1', conversationId: 'cf', workflowRunId: run.id, status: 'answered',
      selectedOption: 'হ্যাঁ, ঠিক আছে', createdAt: new Date(Date.now() + 1000), updatedAt: new Date(),
    })
    await reconcileConversationWorkflows('cf')
    const row = store.workflowRun.find((r) => r.id === run.id)
    expect(row?.state).toBe('post_draft')
  })

  it('non-template card types keep the exact Phase 4 behavior', async () => {
    store.agentPendingAction.push({ id: 'seo1', status: 'pending', type: 'seo_audit', createdAt: new Date(), updatedAt: new Date() })
    const run = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'seo1', conversationId: 'cg', actionType: 'seo_audit', kind: 'seo', goal: 'অডিট',
    })
    expect(run.kind).toBe('seo')
    expect(run.state).toBe('awaiting_approval')
    store.agentPendingAction[0].status = 'executed'
    await syncWorkflowWithPendingAction('seo1', 'approval')
    expect(store.workflowRun.find((r) => r.id === run.id)?.status).toBe('done')
  })
})

describe('staff_task + finance templates (Phase 5)', () => {
  it('dispatch card: approved → dispatching (worker), executed → dispatched done', async () => {
    store.agentPendingAction.push({ id: 'd1', status: 'pending', type: 'dispatch_staff_tasks', createdAt: new Date(), updatedAt: new Date() })
    const run = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'd1', conversationId: 'ch', actionType: 'dispatch_staff_tasks', kind: 'staff_dispatch', goal: 'আজকের টাস্ক',
    })
    expect(run.kind).toBe('staff_task')
    expect(run.state).toBe('dispatch_approval')
    store.agentPendingAction[0].status = 'approved'
    await syncWorkflowWithPendingAction('d1', 'approval')
    expect(store.workflowRun[0].state).toBe('dispatching')
    expect(store.workflowRun[0].status).toBe('waiting_worker')
    store.agentPendingAction[0].status = 'executed'
    await syncWorkflowWithPendingAction('d1', 'worker')
    expect(store.workflowRun[0].state).toBe('dispatched')
    expect(store.workflowRun[0].status).toBe('done')
  })

  it('finance card binds to an active doc_extraction run before finance_approval', async () => {
    const doc = await createWorkflowRun({
      conversationId: 'ci', kind: 'doc_extraction', goal: 'ইনভয়েস', state: 'extracted',
    })
    store.agentPendingAction.push({ id: 'exp1', status: 'pending', type: 'expense', createdAt: new Date(), updatedAt: new Date() })
    const run = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'exp1', conversationId: 'ci', actionType: 'expense', kind: 'finance', goal: 'খরচ',
    })
    expect(run.id).toBe(doc.id)
    expect(run.state).toBe('writeback_approval')
    store.agentPendingAction[0].status = 'executed'
    await syncWorkflowWithPendingAction('exp1', 'approval')
    expect(store.workflowRun[0].state).toBe('written_back')
    expect(store.workflowRun[0].status).toBe('done')
  })
})

describe('execution leases (Phase 5)', () => {
  it('acquire → held → release → acquire again; no run passes through', async () => {
    store.agentPendingAction.push({ id: 'job1', status: 'approved', type: 'image_gen', createdAt: new Date(), updatedAt: new Date() })
    await ensureWorkflowRunForPendingAction({
      pendingActionId: 'job1', conversationId: 'cl', actionType: 'image_gen', kind: 'creative', goal: 'ছবি',
    })
    expect(await acquireWorkflowLease('job1', 60_000)).toBe('acquired')
    expect(await acquireWorkflowLease('job1', 60_000)).toBe('held')
    await releaseWorkflowLease('job1')
    expect(await acquireWorkflowLease('job1', 60_000)).toBe('acquired')
    expect(await acquireWorkflowLease('no_run_card', 60_000)).toBe('no_run')
  })

  it('an expired lease is re-acquirable (crashed worker recovery)', async () => {
    store.agentPendingAction.push({ id: 'job2', status: 'approved', type: 'video_gen', createdAt: new Date(), updatedAt: new Date() })
    const run = await ensureWorkflowRunForPendingAction({
      pendingActionId: 'job2', conversationId: 'cm', actionType: 'video_gen', kind: 'creative', goal: 'রিল',
    })
    expect(await acquireWorkflowLease('job2', 60_000)).toBe('acquired')
    const row = store.workflowRun.find((r) => r.id === run.id)!
    row.leaseUntil = new Date(Date.now() - 1000) // lease expired
    expect(await acquireWorkflowLease('job2', 60_000)).toBe('acquired')
  })

  it('terminal transition clears the lease', async () => {
    const run = await createWorkflowRun({ conversationId: 'cn', kind: 'creative', goal: 'x', pendingActionId: 'job3' })
    store.agentPendingAction.push({ id: 'job3', status: 'approved', type: 'image_gen', createdAt: new Date(), updatedAt: new Date() })
    expect(await acquireWorkflowLease('job3', 60_000)).toBe('acquired')
    await transitionWorkflowRun({ runId: run.id, expectedVersion: run.stateVersion, toStatus: 'done', cause: 'worker' })
    expect(store.workflowRun.find((r) => r.id === run.id)?.leaseUntil).toBeNull()
  })
})

describe('stale-run expiry (Phase 5)', () => {
  it('an active cardless run idle >24h auto-cancels at reconcile', async () => {
    const run = await createWorkflowRun({ conversationId: 'co', kind: 'product_post', goal: 'পুরনো', state: 'preview_confirm' })
    const row = store.workflowRun.find((r) => r.id === run.id)!
    row.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000)
    const remaining = await reconcileConversationWorkflows('co')
    expect(remaining).toHaveLength(0)
    expect(row.status).toBe('cancelled')
    expect(row.state).toBe('stale_expired')
  })

  it('waiting_owner runs are exempt however old they are', async () => {
    const run = await createWorkflowRun({
      conversationId: 'cp', kind: 'browser_setup', goal: 'login অপেক্ষা', status: 'waiting_owner', state: 'awaiting_owner',
    })
    const row = store.workflowRun.find((r) => r.id === run.id)!
    row.updatedAt = new Date(Date.now() - 72 * 60 * 60 * 1000)
    const remaining = await reconcileConversationWorkflows('cp')
    expect(remaining).toHaveLength(1)
    expect(row.status).toBe('waiting_owner')
  })
})
