/**
 * Conversation Focus store (Roadmap 1 Phase 32).
 *
 * The durable "where are we and what happens next" record. A focus points at
 * canonical work (WorkflowRun / checkpoint / open task / card) and carries the
 * continuation contract: goal, current step, verified completed steps, last
 * successful effect, blocker classification, exact next actions, completion
 * criteria, surface, and an optimistic-concurrency version.
 *
 * Stack semantics (no "latest row wins"):
 *   - at most ONE `active` focus per conversation,
 *   - any number `parked` (deliberately set aside by a new task),
 *   - any number `awaiting_owner` (blocked on an approval/ask card).
 *
 * Every write bumps `version` with an optimistic check and appends an
 * AgentFocusEvent — state history is never overwritten. Reads fail open
 * (continuity degrades to legacy behaviour); writes that lose an optimistic
 * race throw FocusVersionConflictError so callers retry with fresh state —
 * they never silently clobber.
 */
import { prisma } from '@/lib/prisma'

// The focus tables land with the Phase 32 migration; typed client may lag in
// checkouts that haven't run `prisma generate` — same accessor pattern as
// workflow-run.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type FocusStatus = 'active' | 'parked' | 'awaiting_owner' | 'done' | 'abandoned'

export interface FocusView {
  id: string
  conversationId: string
  status: FocusStatus
  goal: string
  kind: string
  workflowRunId: string | null
  checkpointTaskRef: string | null
  pendingActionId: string | null
  askCardId: string | null
  currentStep: string | null
  completedSteps: string[]
  lastEffectId: string | null
  lastErrorClass: string | null
  blocker: string | null
  nextActions: string[]
  completionCriteria: string | null
  surface: string | null
  version: number
  updatedAt: Date
}

export class FocusVersionConflictError extends Error {
  constructor(focusId: string, expected: number) {
    super(`focus ${focusId} version conflict (expected ${expected})`)
    this.name = 'FocusVersionConflictError'
  }
}

const SELECT = {
  id: true, conversationId: true, status: true, goal: true, kind: true,
  workflowRunId: true, checkpointTaskRef: true, pendingActionId: true, askCardId: true,
  currentStep: true, completedSteps: true, lastEffectId: true, lastErrorClass: true,
  blocker: true, nextActions: true, completionCriteria: true, surface: true,
  version: true, updatedAt: true,
} as const

function toView(row: Record<string, unknown>): FocusView {
  return {
    ...(row as unknown as FocusView),
    completedSteps: Array.isArray(row.completedSteps) ? (row.completedSteps as string[]) : [],
    nextActions: Array.isArray(row.nextActions) ? (row.nextActions as string[]) : [],
  }
}

async function appendEvent(opts: {
  focusId: string
  conversationId: string
  type: string
  fromStatus?: string | null
  toStatus?: string | null
  version: number
  cause: string
  detail?: Record<string, unknown>
}): Promise<void> {
  try {
    await db.agentFocusEvent.create({
      data: {
        focusId: opts.focusId,
        conversationId: opts.conversationId,
        type: opts.type,
        fromStatus: opts.fromStatus ?? null,
        toStatus: opts.toStatus ?? null,
        version: opts.version,
        cause: opts.cause,
        detail: opts.detail ?? undefined,
      },
    })
  } catch (err) {
    console.warn('[conversation-focus] event append failed:', err instanceof Error ? err.message : err)
  }
}

export interface FocusStack {
  active: FocusView | null
  parked: FocusView[]
  awaitingOwner: FocusView[]
}

/** Load the focus stack. Fail-open: an empty stack on any error. */
export async function getFocusStack(conversationId: string): Promise<FocusStack> {
  try {
    const rows: Array<Record<string, unknown>> = await db.agentConversationFocus.findMany({
      where: { conversationId, status: { in: ['active', 'parked', 'awaiting_owner'] } },
      orderBy: { updatedAt: 'desc' },
      take: 12,
      select: SELECT,
    })
    const views = rows.map(toView)
    return {
      active: views.find((f) => f.status === 'active') ?? null,
      parked: views.filter((f) => f.status === 'parked'),
      awaitingOwner: views.filter((f) => f.status === 'awaiting_owner'),
    }
  } catch (err) {
    console.warn('[conversation-focus] stack read failed open:', err instanceof Error ? err.message : err)
    return { active: null, parked: [], awaitingOwner: [] }
  }
}

/**
 * Create a focus for new non-trivial work. Any existing active focus is
 * PARKED first (never silently mixed or dropped) — the roadmap's
 * "new clear task parks the prior focus" rule, made structural.
 */
export async function createFocus(input: {
  conversationId: string
  businessId?: string
  goal: string
  kind?: string
  workflowRunId?: string | null
  checkpointTaskRef?: string | null
  pendingActionId?: string | null
  askCardId?: string | null
  currentStep?: string | null
  nextActions?: string[]
  completionCriteria?: string | null
  surface?: string | null
  status?: Extract<FocusStatus, 'active' | 'awaiting_owner'>
  cause?: string
}): Promise<FocusView | null> {
  try {
    if ((input.status ?? 'active') === 'active') {
      await parkActiveFocus(input.conversationId, 'new_task', input.cause ?? 'turn')
    }
    const row = await db.agentConversationFocus.create({
      data: {
        conversationId: input.conversationId,
        businessId: input.businessId ?? 'ALMA_LIFESTYLE',
        status: input.status ?? 'active',
        goal: input.goal.slice(0, 2000),
        kind: input.kind ?? 'generic',
        workflowRunId: input.workflowRunId ?? null,
        checkpointTaskRef: input.checkpointTaskRef ?? null,
        pendingActionId: input.pendingActionId ?? null,
        askCardId: input.askCardId ?? null,
        currentStep: input.currentStep ?? null,
        nextActions: input.nextActions ?? undefined,
        completionCriteria: input.completionCriteria ?? null,
        surface: input.surface ?? null,
      },
      select: SELECT,
    })
    await appendEvent({
      focusId: row.id as string,
      conversationId: input.conversationId,
      type: 'created',
      toStatus: (input.status ?? 'active') as string,
      version: 1,
      cause: input.cause ?? 'turn',
      detail: { goal: input.goal.slice(0, 200), kind: input.kind ?? 'generic' },
    })
    return toView(row)
  } catch (err) {
    console.warn('[conversation-focus] create failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Optimistic-concurrency update. `expectedVersion` must match the stored row
 * or FocusVersionConflictError is thrown (append-only event on success).
 */
export async function updateFocus(opts: {
  focusId: string
  expectedVersion: number
  patch: Partial<{
    status: FocusStatus
    currentStep: string | null
    completedSteps: string[]
    lastEffectId: string | null
    lastErrorClass: string | null
    blocker: string | null
    nextActions: string[]
    completionCriteria: string | null
    surface: string | null
    pendingActionId: string | null
    askCardId: string | null
    workflowRunId: string | null
  }>
  cause?: string
  eventType?: string
}): Promise<FocusView> {
  const { focusId, expectedVersion, patch } = opts
  const current: Record<string, unknown> | null = await db.agentConversationFocus.findUnique({
    where: { id: focusId },
    select: SELECT,
  })
  if (!current) throw new Error(`focus ${focusId} not found`)
  const result = await db.agentConversationFocus.updateMany({
    where: { id: focusId, version: expectedVersion },
    data: {
      ...patch,
      completedAt: patch.status === 'done' || patch.status === 'abandoned' ? new Date() : undefined,
      version: expectedVersion + 1,
    },
  })
  if (result.count !== 1) throw new FocusVersionConflictError(focusId, expectedVersion)
  await appendEvent({
    focusId,
    conversationId: current.conversationId as string,
    type: opts.eventType ?? (patch.status ? statusEventType(patch.status) : 'updated'),
    fromStatus: current.status as string,
    toStatus: (patch.status as string | undefined) ?? (current.status as string),
    version: expectedVersion + 1,
    cause: opts.cause ?? 'turn',
    detail: { patch: sanitizePatch(patch) },
  })
  const updated: Record<string, unknown> = await db.agentConversationFocus.findUnique({
    where: { id: focusId },
    select: SELECT,
  })
  return toView(updated)
}

function statusEventType(s: FocusStatus): string {
  switch (s) {
    case 'parked': return 'parked'
    case 'active': return 'resumed'
    case 'awaiting_owner': return 'awaiting_owner'
    case 'done': return 'completed'
    case 'abandoned': return 'abandoned'
  }
}

function sanitizePatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    out[k] = typeof v === 'string' ? v.slice(0, 300) : v
  }
  return out
}

/** Park the conversation's active focus (if any). Fail-open. */
export async function parkActiveFocus(conversationId: string, reason: string, cause = 'turn'): Promise<void> {
  try {
    const active: Record<string, unknown> | null = await db.agentConversationFocus.findFirst({
      where: { conversationId, status: 'active' },
      select: SELECT,
    })
    if (!active) return
    await updateFocus({
      focusId: active.id as string,
      expectedVersion: active.version as number,
      patch: { status: 'parked' },
      cause,
      eventType: 'parked',
    }).catch((err) => {
      if (!(err instanceof FocusVersionConflictError)) throw err
    })
    void reason
  } catch (err) {
    console.warn('[conversation-focus] park failed open:', err instanceof Error ? err.message : err)
  }
}

/** Resume a parked/awaiting focus as the active one (parks any current active). */
export async function activateFocus(focusId: string, cause = 'turn'): Promise<FocusView | null> {
  try {
    const row: Record<string, unknown> | null = await db.agentConversationFocus.findUnique({
      where: { id: focusId },
      select: SELECT,
    })
    if (!row) return null
    if (row.status === 'active') return toView(row)
    await parkActiveFocus(row.conversationId as string, 'switch', cause)
    return await updateFocus({
      focusId,
      expectedVersion: row.version as number,
      patch: { status: 'active' },
      cause,
      eventType: 'resumed',
    })
  } catch (err) {
    console.warn('[conversation-focus] activate failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Bridge: make sure a WorkflowRun has a focus row (creates one bound to the
 * run when missing). Called on run creation — a focus therefore exists for
 * every templated job automatically; untemplated work gets one from the
 * resolver path in run-owner-turn.
 */
export async function ensureFocusForWorkflowRun(run: {
  id: string
  conversationId: string | null
  businessId?: string
  kind: string
  goal: string
  status: string
  state: string
  nextAllowedTools?: string[] | null
  pendingActionId?: string | null
}, cause = 'turn'): Promise<FocusView | null> {
  if (!run.conversationId) return null
  try {
    const existing: Record<string, unknown> | null = await db.agentConversationFocus.findFirst({
      where: { workflowRunId: run.id, status: { in: ['active', 'parked', 'awaiting_owner'] } },
      select: SELECT,
    })
    if (existing) return toView(existing)
    return await createFocus({
      conversationId: run.conversationId,
      businessId: run.businessId,
      goal: run.goal,
      kind: run.kind,
      workflowRunId: run.id,
      currentStep: run.state,
      nextActions: run.nextAllowedTools ?? undefined,
      pendingActionId: run.pendingActionId ?? null,
      status: run.status === 'waiting_owner' ? 'awaiting_owner' : 'active',
      cause,
    })
  } catch (err) {
    console.warn('[conversation-focus] ensure-for-run failed open:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Bridge: mirror a WorkflowRun transition onto its focus (step/status/blocker).
 * Fail-open — the run remains canonical for templated jobs; the focus is the
 * conversation-level continuation contract.
 */
export async function syncFocusWithWorkflowRun(run: {
  id: string
  status: string
  state: string
  nextAllowedTools?: string[] | null
  pendingActionId?: string | null
}, cause = 'reconcile'): Promise<void> {
  try {
    const row: Record<string, unknown> | null = await db.agentConversationFocus.findFirst({
      where: { workflowRunId: run.id, status: { in: ['active', 'parked', 'awaiting_owner'] } },
      select: SELECT,
    })
    if (!row) return
    const terminal = ['done', 'failed', 'cancelled'].includes(run.status)
    const status: FocusStatus = terminal
      ? (run.status === 'done' ? 'done' : 'abandoned')
      : run.status === 'waiting_owner' ? 'awaiting_owner'
      : (row.status as FocusStatus) === 'parked' ? 'parked'
      : 'active'
    await updateFocus({
      focusId: row.id as string,
      expectedVersion: row.version as number,
      patch: {
        status,
        currentStep: run.state,
        ...(run.nextAllowedTools !== undefined ? { nextActions: run.nextAllowedTools ?? [] } : {}),
        ...(run.pendingActionId !== undefined ? { pendingActionId: run.pendingActionId } : {}),
        blocker: run.status === 'waiting_owner' ? 'owner' : run.status === 'failed' ? 'system' : null,
      },
      cause,
      eventType: terminal ? statusEventType(status) : 'updated',
    }).catch((err) => {
      if (!(err instanceof FocusVersionConflictError)) throw err
    })
  } catch (err) {
    console.warn('[conversation-focus] sync failed open:', err instanceof Error ? err.message : err)
  }
}

/** Record a verified effect on the focus — the never-repeat ledger. */
export async function recordVerifiedEffect(focusId: string, effectId: string, step?: string): Promise<void> {
  try {
    const row: Record<string, unknown> | null = await db.agentConversationFocus.findUnique({
      where: { id: focusId },
      select: SELECT,
    })
    if (!row) return
    const done = new Set<string>(Array.isArray(row.completedSteps) ? (row.completedSteps as string[]) : [])
    if (step) done.add(step)
    await updateFocus({
      focusId,
      expectedVersion: row.version as number,
      patch: { lastEffectId: effectId, completedSteps: [...done] },
      cause: 'turn',
      eventType: 'updated',
    }).catch((err) => {
      if (!(err instanceof FocusVersionConflictError)) throw err
    })
  } catch (err) {
    console.warn('[conversation-focus] effect record failed open:', err instanceof Error ? err.message : err)
  }
}

/** Deterministic Bangla context block for the head (per-turn, transient). */
export function buildFocusSystemNote(stack: FocusStack): string {
  const lines: string[] = []
  if (stack.active) {
    const f = stack.active
    lines.push(
      `• সক্রিয় কাজ: "${f.goal.slice(0, 90)}" [${f.kind}] → ধাপ: ${f.currentStep ?? 'শুরু'}` +
      (f.nextActions.length ? ` → পরের বৈধ ধাপ: ${f.nextActions.slice(0, 4).join(', ')}` : '') +
      (f.completedSteps.length ? ` — সম্পন্ন (আর করা নিষেধ): ${f.completedSteps.slice(-4).join(', ')}` : ''),
    )
    if (f.blocker) lines.push(`  ⤷ আটকে আছে: ${f.blocker === 'owner' ? 'Boss-এর সিদ্ধান্ত' : f.blocker}${f.lastErrorClass ? ` (${f.lastErrorClass})` : ''}`)
  }
  for (const f of stack.awaitingOwner.slice(0, 2)) {
    lines.push(`• Boss-এর অপেক্ষায়: "${f.goal.slice(0, 70)}" (ধাপ: ${f.currentStep ?? '—'})`)
  }
  for (const f of stack.parked.slice(0, 2)) {
    lines.push(`• পার্ক করা: "${f.goal.slice(0, 70)}" — Boss চাইলে resume হবে`)
  }
  if (lines.length === 0) return ''
  return (
    '[CONVERSATION FOCUS — একমাত্র সত্য অবস্থা]\n' +
    'নিচের রেকর্ডটাই চলমান কাজের ক্যানোনিকাল অবস্থা — চ্যাট-স্মৃতি নয়। ' +
    '"সম্পন্ন" চিহ্নিত ধাপ/ইফেক্ট আবার চালানো নিষেধ; ঠিক পরের বৈধ ধাপ থেকে এগোও।\n' +
    lines.join('\n')
  )
}
