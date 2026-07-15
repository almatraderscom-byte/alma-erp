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
import {
  templateKindsForCardType,
  getWorkflowTemplate,
  getTemplateStep,
  nextAllowedToolsFor,
  templateCardTransition,
} from './workflow-templates'
import type { WorkflowStatus } from './workflow-run-types'
import { TERMINAL_WORKFLOW_STATUSES } from './workflow-run-types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type { WorkflowStatus }
export { TERMINAL_WORKFLOW_STATUSES }

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
 *
 * Phase 5 (templates): when the card type belongs to a workflow template,
 *  - an ACTIVE run of that template in the same conversation CLAIMS the card
 *    (transitioning to the card's approval step) instead of a duplicate run
 *    being created — one product-post job stays ONE run across its image and
 *    post cards;
 *  - a fresh run starts at the template's card step with the step's
 *    nextAllowedTools, not the generic 'awaiting_approval'.
 * Card types without a template keep the exact Phase 4 behavior.
 */
export async function ensureWorkflowRunForPendingAction(opts: {
  pendingActionId: string
  conversationId: string | null
  businessId?: string
  /** Pending-action card type — drives the template mapping. */
  actionType?: string
  /** Legacy fallback kind (state-router pack key) when no template matches. */
  kind: string
  goal: string
}): Promise<WorkflowRunView> {
  const existing = await getWorkflowRunByPendingAction(opts.pendingActionId)
  if (existing) return existing

  const templateKinds = opts.actionType ? templateKindsForCardType(opts.actionType) : []

  // Attach to the conversation's active run of the same template (priority order).
  if (opts.conversationId && templateKinds.length > 0) {
    try {
      const active = await listActiveWorkflowRuns(opts.conversationId)
      for (const kind of templateKinds) {
        const run = active.find((r) => r.kind === kind)
        if (!run) continue
        const tpl = getWorkflowTemplate(kind)
        const cs = tpl?.cardSteps[opts.actionType ?? '']
        if (!tpl || !cs) continue
        const updated = await transitionWorkflowRun({
          runId: run.id,
          expectedVersion: run.stateVersion,
          toStatus: tpl.steps[cs.stage]?.status ?? 'waiting_owner',
          toState: cs.stage,
          nextAllowedTools: nextAllowedToolsFor(kind, cs.stage),
          pendingActionId: opts.pendingActionId,
          cause: 'turn',
          detail: { attachedCard: opts.pendingActionId, cardType: opts.actionType },
        })
        await db.agentPendingAction.update({
          where: { id: opts.pendingActionId },
          data: { workflowRunId: updated.id },
        }).catch(() => {})
        return updated
      }
    } catch { /* attach is best-effort — fall through to create */ }
  }

  // Create: template card step when known, legacy generic step otherwise.
  const tplKind = templateKinds[0]
  const tpl = tplKind ? getWorkflowTemplate(tplKind) : undefined
  const cs = tpl && opts.actionType ? tpl.cardSteps[opts.actionType] : undefined
  const run = await createWorkflowRun({
    conversationId: opts.conversationId,
    businessId: opts.businessId,
    kind: tpl && cs ? tpl.kind : opts.kind,
    goal: opts.goal,
    status: (tpl && cs && tpl.steps[cs.stage]?.status) || 'waiting_owner',
    state: tpl && cs ? cs.stage : 'awaiting_approval',
    nextAllowedTools: tpl && cs ? nextAllowedToolsFor(tpl.kind, cs.stage) : undefined,
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
  const cardType = String(action.type ?? '')
  try {
    if (run.kind === 'client_seo_batch' && cardType === 'seo_audit') {
      if (s === 'executed' || s === 'failed') {
        const { recordClientSeoAuditResult } = await import('./client-seo-batch')
        await recordClientSeoAuditResult(run, pendingActionId, s === 'executed', cause)
      }
      return
    }
    if (s === 'executed') {
      // Template runs advance to the CARD'S next step (an executed image card is
      // NOT the end of a product post — the run moves to preview_confirm). Facts
      // record what the card produced so later guards/steps can rely on it.
      const t = templateCardTransition(run.kind, cardType, 'executed')
      const isTerminal = !t || TERMINAL_WORKFLOW_STATUSES.includes(t.toStatus)
      await transitionWorkflowRun({
        runId: run.id, expectedVersion: run.stateVersion,
        toStatus: t?.toStatus ?? 'done', toState: t?.toState ?? 'executed', cause,
        nextAllowedTools: t ? nextAllowedToolsFor(run.kind, t.toState) : undefined,
        facts: t && cardType === 'image_gen'
          ? { ...(run.facts ?? {}), imageGenerated: true, previewConfirmed: false }
          : undefined,
        lastProof: isTerminal
          ? { kind: 'pending_action', ref: pendingActionId, verifiedAt: new Date().toISOString() }
          : undefined,
        // The claimed card is resolved — free the slot so the next step's card
        // (e.g. the post card after the image) can claim this same run.
        pendingActionId: isTerminal ? undefined : null,
      })
    } else if (s === 'rejected' || s === 'dismissed' || s === 'cancelled') {
      // A rejected image/post card usually means "change it", not "cancel the
      // job" — template runs fall back to their revision step and stay alive.
      const t = s === 'rejected' ? templateCardTransition(run.kind, cardType, 'rejected') : null
      await transitionWorkflowRun({
        runId: run.id, expectedVersion: run.stateVersion,
        toStatus: t?.toStatus ?? 'cancelled', toState: t?.toState ?? s, cause,
        nextAllowedTools: t ? nextAllowedToolsFor(run.kind, t.toState) : undefined,
        pendingActionId: t ? null : undefined,
      })
    } else if (s === 'failed') {
      await transitionWorkflowRun({
        runId: run.id, expectedVersion: run.stateVersion,
        toStatus: 'failed', toState: 'failed', cause,
      })
    } else if (s === 'approved' && run.status === 'waiting_owner') {
      const t = templateCardTransition(run.kind, cardType, 'approved')
      await transitionWorkflowRun({
        runId: run.id, expectedVersion: run.stateVersion,
        toStatus: t?.toStatus ?? 'waiting_worker', toState: t?.toState ?? 'approved_queued', cause,
        nextAllowedTools: t ? nextAllowedToolsFor(run.kind, t.toState) : undefined,
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
 *
 * Phase 5 adds stale-run expiry: an 'active' run with NO pending card that has
 * not moved in 24h is abandoned work (e.g. a standalone image delivered at
 * preview_confirm, a browser errand finished mid-chat) — auto-close it so it
 * stops steering the router/snapshot forever. waiting_owner/waiting_worker
 * runs are exempt: those are legitimately parked on someone else.
 */
const STALE_ACTIVE_RUN_MS = 24 * 60 * 60 * 1000

export async function reconcileConversationWorkflows(conversationId: string): Promise<WorkflowRunView[]> {
  const runs = await listActiveWorkflowRuns(conversationId)
  for (const run of runs) {
    if (
      run.status === 'active'
      && !run.pendingActionId
      && Date.now() - run.updatedAt.getTime() > STALE_ACTIVE_RUN_MS
    ) {
      try {
        await transitionWorkflowRun({
          runId: run.id, expectedVersion: run.stateVersion,
          toStatus: 'cancelled', toState: 'stale_expired', cause: 'reconcile',
          detail: { idleHours: Math.round((Date.now() - run.updatedAt.getTime()) / 3_600_000) },
        })
      } catch { /* fail-open */ }
      continue
    }
    if (run.pendingActionId) {
      try {
        await syncWorkflowWithPendingAction(run.pendingActionId, 'reconcile')
      } catch { /* per-run fail-open */ }
    }
    // Phase 5: a step gated on an ask-card answer (image preview confirm)
    // advances here — path-independent (both heads reconcile at turn start),
    // no reliance on the model re-reading its own question. Only answers that
    // arrived AFTER the run entered the current step count.
    const step = getTemplateStep(run.kind, run.state)
    if (step?.onAskAnswer) {
      try {
        const card = await db.agentAskCard.findFirst({
          where: {
            workflowRunId: run.id,
            status: 'answered',
            createdAt: { gt: run.updatedAt },
          },
          orderBy: { createdAt: 'desc' },
          select: { selectedOption: true },
        })
        if (card?.selectedOption) {
          await advanceWorkflowOnAskAnswer(run.id, String(card.selectedOption), 'reconcile')
        }
      } catch { /* per-run fail-open */ }
    }
  }
  return listActiveWorkflowRuns(conversationId)
}

/**
 * Merge a facts patch WITHOUT a state transition (no version bump, no event) —
 * pure bookkeeping like the live-browser session snapshot, updated on every
 * action. Last write wins; never throws.
 */
export async function updateWorkflowFacts(runId: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const row = await db.workflowRun.findUnique({ where: { id: runId }, select: { facts: true } })
    if (!row) return
    const merged = { ...((row.facts as Record<string, unknown> | null) ?? {}), ...patch }
    await db.workflowRun.update({ where: { id: runId }, data: { facts: merged } })
  } catch { /* bookkeeping must never break a tool call */ }
}

/**
 * Get-or-create the conversation's active run of a template kind — used by
 * executor hooks that begin a job WITHOUT a card (live browser work, invoice
 * extraction). Idempotent per conversation+kind while the run stays open.
 */
export async function ensureActiveWorkflowRun(opts: {
  conversationId: string
  businessId?: string
  kind: string
  goal: string
  state?: string
  facts?: Record<string, unknown>
  nextAllowedTools?: string[]
}): Promise<WorkflowRunView | null> {
  try {
    const active = await listActiveWorkflowRuns(opts.conversationId)
    const existing = active.find((r) => r.kind === opts.kind)
    if (existing) return existing
    return await createWorkflowRun({
      conversationId: opts.conversationId,
      businessId: opts.businessId,
      kind: opts.kind,
      goal: opts.goal,
      status: 'active',
      state: opts.state,
      facts: opts.facts,
      nextAllowedTools: opts.nextAllowedTools,
      cause: 'auto',
    })
  } catch {
    return null
  }
}

// ── Phase 5 execution leases (roadmap §A leaseUntil) ─────────────────────────

/**
 * Try to acquire the execution lease on the run behind a pending action —
 * called when the VPS worker is HANDED the job (internal pending-jobs route).
 * Atomic: only one holder can move leaseUntil forward while it is free/expired.
 *
 *  - 'acquired' → hand the job out (lease now held for ttlMs)
 *  - 'held'     → another worker/poll already holds it — do NOT hand out again
 *  - 'no_run'   → no workflow run behind this card (legacy/cron rows): pass through
 */
export async function acquireWorkflowLease(pendingActionId: string, ttlMs: number): Promise<'acquired' | 'held' | 'no_run'> {
  const now = new Date()
  const claimed = await db.workflowRun.updateMany({
    where: {
      pendingActionId,
      status: { in: ['active', 'waiting_owner', 'waiting_worker'] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil: new Date(now.getTime() + ttlMs) },
  })
  if (claimed.count > 0) return 'acquired'
  const run = await db.workflowRun.findFirst({
    where: { pendingActionId, status: { in: ['active', 'waiting_owner', 'waiting_worker'] } },
    select: { leaseUntil: true },
  })
  if (!run) return 'no_run'
  return run.leaseUntil && run.leaseUntil > now ? 'held' : 'no_run'
}

/** Release the lease early (worker reported its result). Terminal transitions clear it anyway. */
export async function releaseWorkflowLease(pendingActionId: string): Promise<void> {
  try {
    await db.workflowRun.updateMany({
      where: { pendingActionId },
      data: { leaseUntil: null },
    })
  } catch { /* fail-open */ }
}

/**
 * Phase 5: an answered ask-card that is BOUND to a run (workflowRunId) can move
 * the template's state machine — e.g. the product-post preview confirm: "ঠিক
 * আছে" unlocks the post step (facts.previewConfirmed), "change চাই" falls back
 * to drafting. No-op for non-template runs/steps. Fail-open.
 */
export async function advanceWorkflowOnAskAnswer(runId: string, selectedOption: string, cause = 'turn'): Promise<void> {
  try {
    const row = await db.workflowRun.findUnique({ where: { id: runId }, select: VIEW_SELECT })
    if (!row) return
    const run = toView(row)
    if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) return
    const step = getTemplateStep(run.kind, run.state)
    const move = step?.onAskAnswer?.(selectedOption)
    if (!move) return
    const toStep = getTemplateStep(run.kind, move.toState)
    await transitionWorkflowRun({
      runId: run.id,
      expectedVersion: run.stateVersion,
      toStatus: toStep?.status ?? 'active',
      toState: move.toState,
      facts: move.facts ? { ...(run.facts ?? {}), ...move.facts } : undefined,
      nextAllowedTools: nextAllowedToolsFor(run.kind, move.toState),
      cause,
      detail: { askAnswer: selectedOption.slice(0, 120) },
    })
  } catch (err) {
    if (!(err instanceof WorkflowVersionConflictError)) {
      console.warn('[workflow-run] ask-answer advance failed open:', err instanceof Error ? err.message : err)
    }
  }
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
    const step = getTemplateStep(r.kind, r.state)
    const stepLabel = step ? `${r.state} — ${step.labelBn}` : r.state
    const tools = r.nextAllowedTools?.length ? ` পরের বৈধ টুল: ${r.nextAllowedTools.slice(0, 6).join(', ')}।` : ''
    const expected = (() => {
      if (!step?.expectedTool) return ''
      const name = typeof step.expectedTool === 'function' ? step.expectedTool(r.facts ?? {}) : step.expectedTool
      return name ? ` এই ধাপের প্রত্যাশিত পরের কাজ: ${name} call।` : ''
    })()
    const card = r.pendingActionId ? ` (approval card: ${r.pendingActionId.slice(0, 8)}…)` : ''
    return `• [${r.kind}] "${r.goal.slice(0, 120)}" — অবস্থা: ${workflowStatusBn(r.status)}, ধাপ: ${stepLabel}${card}।${tools}${expected}`
  })
  return (
    `[চলমান কাজের ক্যানোনিকাল অবস্থা — WorkflowRun]\n${lines.join('\n')}\n` +
    'Boss "হ্যাঁ/ঠিক আছে/continue" বললে এটা উপরের কাজের উত্তর — ঠিক ওই ধাপ থেকে চালিয়ে যাও, ' +
    'গোড়া থেকে শুরু করা বা নতুন কার্ড বানানো নিষেধ। waiting_owner মানে কার্ডের সিদ্ধান্তের অপেক্ষা — নতুন করে stage কোরো না।'
  )
}
