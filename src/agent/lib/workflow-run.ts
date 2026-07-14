/**
 * Phase 4 (roadmap AGENT-STATE-001) — WorkflowRun transition service.
 *
 * ONE canonical record answers: what outcome is being pursued, what state is it
 * in, and what is legal next. Everything here is designed to be called from
 * fail-open hooks (a workflow bookkeeping error must never break a live turn),
 * while the transitions themselves are strict: optimistic stateVersion,
 * append-only event log, terminal states auto-close the linked open tasks.
 *
 * Status machine:
 *   active ──────────→ waiting_owner (card staged / question asked)
 *   waiting_owner ───→ active (owner replied/approved-into-work) | done | cancelled
 *   active ──────────→ waiting_worker (queued on VPS/provider)
 *   any non-terminal ─→ done | failed | cancelled  (terminal, sets completedAt)
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type WorkflowStatus = 'active' | 'waiting_owner' | 'waiting_worker' | 'done' | 'failed' | 'cancelled'

export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowStatus[] = ['done', 'failed', 'cancelled']

export interface WorkflowRunView {
  id: string
  conversationId: string | null
  businessId: string
  kind: string
  goal: string
  status: WorkflowStatus
  state: string
  stateVersion: number
  facts: Record<string, unknown> | null
  nextAllowedTools: string[] | null
  pendingActionId: string | null
  createdAt: Date
  updatedAt: Date
}

const VIEW_SELECT = {
  id: true, conversationId: true, businessId: true, kind: true, goal: true,
  status: true, state: true, stateVersion: true, facts: true,
  nextAllowedTools: true, pendingActionId: true, createdAt: true, updatedAt: true,
} as const

function toView(row: Record<string, unknown>): WorkflowRunView {
  return {
    ...(row as unknown as WorkflowRunView),
    nextAllowedTools: Array.isArray(row.nextAllowedTools) ? (row.nextAllowedTools as string[]) : null,
    facts: (row.facts as Record<string, unknown> | null) ?? null,
  }
}

async function logEvent(
  runId: string,
  fromStatus: string | null,
  toStatus: string,
  fromState: string | null,
  toState: string,
  stateVersion: number,
  cause: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.workflowRunEvent.create({
      data: { workflowRunId: runId, fromStatus, toStatus, fromState, toState, stateVersion, cause, detail: detail ?? undefined },
    })
  } catch { /* append-only log must never block a transition */ }
}

export async function createWorkflowRun(input: {
  conversationId?: string | null
  businessId?: string
  kind: string
  goal: string
  status?: WorkflowStatus
  state?: string
  inputs?: Record<string, unknown>
  facts?: Record<string, unknown>
  nextAllowedTools?: string[]
  pendingActionId?: string | null
  cause?: string
}): Promise<WorkflowRunView> {
  const row = await db.workflowRun.create({
    data: {
      conversationId: input.conversationId ?? null,
      businessId: input.businessId ?? 'ALMA_LIFESTYLE',
      kind: input.kind,
      goal: input.goal.slice(0, 2000),
      status: input.status ?? 'active',
      state: input.state ?? 'started',
      inputs: input.inputs ?? undefined,
      facts: input.facts ?? undefined,
      nextAllowedTools: input.nextAllowedTools ?? undefined,
      pendingActionId: input.pendingActionId ?? null,
    },
    select: VIEW_SELECT,
  })
  await logEvent(row.id, null, row.status, null, row.state, row.stateVersion, input.cause ?? 'turn', { created: true })
  return toView(row)
}

export class WorkflowVersionConflictError extends Error {
  constructor(runId: string, expected: number) {
    super(`workflow_version_conflict: run ${runId} moved past version ${expected}`)
    this.name = 'WorkflowVersionConflictError'
  }
}

/**
 * Optimistic transition: succeeds ONLY when the run is still at
 * `expectedVersion` — otherwise throws WorkflowVersionConflictError. Terminal
 * transitions stamp completedAt; every transition bumps stateVersion and logs
 * an event. This is the "no action executes against an outdated workflow
 * version" primitive.
 */
export async function transitionWorkflowRun(opts: {
  runId: string
  expectedVersion: number
  toStatus?: WorkflowStatus
  toState?: string
  cause: string
  facts?: Record<string, unknown>
  artifacts?: Record<string, unknown>
  nextAllowedTools?: string[]
  pendingActionId?: string | null
  lastProof?: Record<string, unknown>
  detail?: Record<string, unknown>
}): Promise<WorkflowRunView> {
  const current = await db.workflowRun.findUnique({ where: { id: opts.runId }, select: VIEW_SELECT })
  if (!current) throw new Error(`workflow_run_not_found: ${opts.runId}`)

  const toStatus = opts.toStatus ?? (current.status as WorkflowStatus)
  const toState = opts.toState ?? (current.state as string)
  const terminal = TERMINAL_WORKFLOW_STATUSES.includes(toStatus)

  const result = await db.workflowRun.updateMany({
    where: { id: opts.runId, stateVersion: opts.expectedVersion },
    data: {
      status: toStatus,
      state: toState,
      stateVersion: { increment: 1 },
      ...(opts.facts !== undefined ? { facts: opts.facts } : {}),
      ...(opts.artifacts !== undefined ? { artifacts: opts.artifacts } : {}),
      ...(opts.nextAllowedTools !== undefined ? { nextAllowedTools: opts.nextAllowedTools } : {}),
      ...(opts.pendingActionId !== undefined ? { pendingActionId: opts.pendingActionId } : {}),
      ...(opts.lastProof !== undefined ? { lastProof: opts.lastProof } : {}),
      ...(terminal ? { completedAt: new Date(), leaseUntil: null } : {}),
    },
  })
  if (result.count === 0) throw new WorkflowVersionConflictError(opts.runId, opts.expectedVersion)

  await logEvent(
    opts.runId,
    current.status, toStatus,
    current.state, toState,
    opts.expectedVersion + 1,
    opts.cause,
    opts.detail,
  )

  if (terminal) await closeLinkedFragments(opts.runId, toStatus, opts.cause)

  const updated = await db.workflowRun.findUnique({ where: { id: opts.runId }, select: VIEW_SELECT })
  return toView(updated)
}

/**
 * Terminal auto-close (exit gate "stale open-task chip rate <1%"): a run
 * reaching done/failed/cancelled resolves its linked open-task chips and
 * checkpoints itself — never relies on the model calling resolve_open_task.
 */
async function closeLinkedFragments(runId: string, toStatus: WorkflowStatus, cause: string): Promise<void> {
  try {
    await db.agentOpenTask.updateMany({
      where: { workflowRunId: runId, status: { in: ['open', 'running'] } },
      data: {
        status: toStatus === 'done' ? 'done' : 'cancelled',
        completedAt: new Date(),
      },
    })
  } catch { /* fail-open */ }
  try {
    // Also close chips linked via the run's pending action (pre-Phase-4 rows
    // carry pendingActionId but not workflowRunId).
    const run = await db.workflowRun.findUnique({ where: { id: runId }, select: { pendingActionId: true } })
    if (run?.pendingActionId) {
      await db.agentOpenTask.updateMany({
        where: { pendingActionId: run.pendingActionId, status: { in: ['open', 'running'] } },
        data: { status: toStatus === 'done' ? 'done' : 'cancelled', completedAt: new Date() },
      })
    }
  } catch { /* fail-open */ }
  void cause
}

/** Active (non-terminal) runs for a conversation, most recent first. */
export async function listActiveWorkflowRuns(conversationId: string, limit = 5): Promise<WorkflowRunView[]> {
  const rows = await db.workflowRun.findMany({
    where: { conversationId, status: { in: ['active', 'waiting_owner', 'waiting_worker'] } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: VIEW_SELECT,
  })
  return (rows as Record<string, unknown>[]).map(toView)
}

export async function getWorkflowRunByPendingAction(pendingActionId: string): Promise<WorkflowRunView | null> {
  const row = await db.workflowRun.findFirst({
    where: { pendingActionId },
    orderBy: { createdAt: 'desc' },
    select: VIEW_SELECT,
  })
  return row ? toView(row) : null
}

/**
 * Ensure ONE workflow run exists for a staged approval card (idempotent on
 * pendingActionId). Called from the turn-end hook for every card the turn
 * staged; also stamps workflowRunId onto the pending action row.
 */
export async function ensureWorkflowRunForPendingAction(opts: {
  pendingActionId: string
  conversationId: string | null
  businessId?: string
  kind: string
  goal: string
}): Promise<WorkflowRunView> {
  const existing = await getWorkflowRunByPendingAction(opts.pendingActionId)
  if (existing) return existing
  const run = await createWorkflowRun({
    conversationId: opts.conversationId,
    businessId: opts.businessId,
    kind: opts.kind,
    goal: opts.goal,
    status: 'waiting_owner',
    state: 'awaiting_approval',
    pendingActionId: opts.pendingActionId,
    cause: 'turn',
  })
  try {
    await db.agentPendingAction.update({
      where: { id: opts.pendingActionId },
      data: { workflowRunId: run.id },
    })
  } catch { /* link is best-effort; getWorkflowRunByPendingAction covers reads */ }
  return run
}

/**
 * Approval-time execution guard (exit gate "no action executes against an
 * outdated workflow version"): approving a card whose workflow the owner
 * already cancelled/finished must NOT execute. Fail-open on lookup errors —
 * the guard only blocks on a POSITIVE terminal finding.
 */
export async function workflowBlocksApproval(pendingActionId: string): Promise<{ blocked: boolean; reason?: string }> {
  try {
    const run = await getWorkflowRunByPendingAction(pendingActionId)
    if (run && TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
      return {
        blocked: true,
        reason: `এই কার্ডের কাজটা ইতিমধ্যে ${run.status === 'done' ? 'শেষ' : 'বাতিল'} হয়ে গেছে (workflow ${run.id.slice(0, 8)}) — পুরনো কার্ড approve করা নিরাপদ নয়। দরকার হলে নতুন করে বলুন।`,
      }
    }
  } catch { /* fail-open */ }
  return { blocked: false }
}

/**
 * Reconcile a run against its pending action's CURRENT status. Called on
 * approval routes (fire-and-forget) and lazily at turn start, so scattered
 * per-type execution branches never need individual hooks.
 */
export async function syncWorkflowWithPendingAction(pendingActionId: string, cause = 'reconcile'): Promise<void> {
  const run = await getWorkflowRunByPendingAction(pendingActionId)
  if (!run || TERMINAL_WORKFLOW_STATUSES.includes(run.status)) return
  const action = await db.agentPendingAction.findUnique({
    where: { id: pendingActionId },
    select: { status: true, result: true, type: true },
  })
  if (!action) return
  const s = String(action.status)
  try {
    if (s === 'executed') {
      await transitionWorkflowRun({
        runId: run.id, expectedVersion: run.stateVersion,
        toStatus: 'done', toState: 'executed', cause,
        lastProof: { kind: 'pending_action', ref: pendingActionId, verifiedAt: new Date().toISOString() },
      })
    } else if (s === 'rejected' || s === 'dismissed' || s === 'cancelled') {
      await transitionWorkflowRun({
        runId: run.id, expectedVersion: run.stateVersion,
        toStatus: 'cancelled', toState: s, cause,
      })
    } else if (s === 'failed') {
      await transitionWorkflowRun({
        runId: run.id, expectedVersion: run.stateVersion,
        toStatus: 'failed', toState: 'failed', cause,
      })
    } else if (s === 'approved' && run.status === 'waiting_owner') {
      await transitionWorkflowRun({
        runId: run.id, expectedVersion: run.stateVersion,
        toStatus: 'waiting_worker', toState: 'approved_queued', cause,
      })
    }
  } catch (err) {
    // Version conflict = someone else already transitioned — that's fine.
    if (!(err instanceof WorkflowVersionConflictError)) throw err
  }
}

/**
 * Lazy reconciliation at turn start: every non-terminal run with a pending
 * action syncs to that action's real status, so approvals executed via the
 * many per-type route branches (no direct hook) still close their runs before
 * routing reads the state. Fail-open per run.
 */
export async function reconcileConversationWorkflows(conversationId: string): Promise<WorkflowRunView[]> {
  const runs = await listActiveWorkflowRuns(conversationId)
  for (const run of runs) {
    if (!run.pendingActionId) continue
    try {
      await syncWorkflowWithPendingAction(run.pendingActionId, 'reconcile')
    } catch { /* per-run fail-open */ }
  }
  return listActiveWorkflowRuns(conversationId)
}

/** Owner-readable one-line Bangla label for the snapshot note. */
export function workflowStatusBn(status: WorkflowStatus): string {
  switch (status) {
    case 'waiting_owner': return 'Boss-এর সিদ্ধান্তের অপেক্ষায়'
    case 'waiting_worker': return 'কাজ চলছে (queued)'
    case 'active': return 'চলমান'
    case 'done': return 'শেষ'
    case 'failed': return 'ব্যর্থ'
    case 'cancelled': return 'বাতিল'
  }
}

/**
 * The per-turn snapshot note (volatile context): the head reads the EXACT
 * in-flight state before anything else — this is what makes "হ্যাঁ/continue"
 * resume the blocked step instead of restarting from zero.
 */
export function buildWorkflowSnapshotNote(runs: WorkflowRunView[]): string {
  if (runs.length === 0) return ''
  const lines = runs.slice(0, 3).map((r) => {
    const tools = r.nextAllowedTools?.length ? ` পরের বৈধ টুল: ${r.nextAllowedTools.slice(0, 5).join(', ')}।` : ''
    const card = r.pendingActionId ? ` (approval card: ${r.pendingActionId.slice(0, 8)}…)` : ''
    return `• [${r.kind}] "${r.goal.slice(0, 120)}" — অবস্থা: ${workflowStatusBn(r.status)}, ধাপ: ${r.state}${card}।${tools}`
  })
  return (
    `[চলমান কাজের ক্যানোনিকাল অবস্থা — WorkflowRun]\n${lines.join('\n')}\n` +
    'Boss "হ্যাঁ/ঠিক আছে/continue" বললে এটা উপরের কাজের উত্তর — ঠিক ওই ধাপ থেকে চালিয়ে যাও, ' +
    'গোড়া থেকে শুরু করা বা নতুন কার্ড বানানো নিষেধ। waiting_owner মানে কার্ডের সিদ্ধান্তের অপেক্ষা — নতুন করে stage কোরো না।'
  )
}
