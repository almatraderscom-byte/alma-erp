/**
 * Build 103 Issue 3 — the truthful in-chat work-step tracker.
 *
 * `work_steps_snapshot` is a full authoritative snapshot (never a fragile
 * partial patch) of one logical task's numbered steps. Its ONLY source of
 * completion truth is the durable `AgentPlan`/`AgentPlanStep` rows, which the
 * execution machinery already moves through pending → running → done/failed
 * as real work happens. Prose promises, thinking deltas, elapsed time, and
 * tool selection are never evidence; there is no estimated percentage.
 *
 * Linkage is exact: a plan is created with the turn that accepted the owner's
 * request (`originTurnId`), and only that turn, an already-chained turn, or an
 * explicit continuation of the same task may re-emit it. An old plan can never
 * attach to a new request merely because it is the newest conversation plan.
 */
import { prisma } from '@/lib/prisma'
import { toolDisplay } from '@/agent/lib/tool-labels'

export const WORK_STEPS_SNAPSHOT_VERSION = 1 as const

export type WorkStepsOverallStatus =
  | 'preparing'
  | 'running'
  | 'waiting_owner'
  | 'waiting_worker'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type WorkStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_owner'
  | 'waiting_worker'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export type WorkStepsBlocker = {
  kind: 'approval' | 'question' | 'model_switch' | 'worker' | 'queue' | 'global_pause'
  refId: string
}

/** Reconcile a persisted blocker with the durable card/action row read now. */
export function reconcileDurableWorkStepsBlocker(
  blocker: WorkStepsBlocker | null,
  durableStatus: string | null,
): WorkStepsBlocker | null {
  if (!blocker) return null
  if (blocker.kind === 'approval' || blocker.kind === 'worker') {
    if (durableStatus === 'pending') return { kind: 'approval', refId: blocker.refId }
    if (durableStatus === 'approved') return { kind: 'worker', refId: blocker.refId }
    return null
  }
  if (blocker.kind === 'question') {
    return durableStatus === 'pending' ? blocker : null
  }
  return blocker
}

export type WorkStepsSnapshotStep = {
  id: string
  position: number
  title: string
  status: WorkStepStatus
  toolCallIds: string[]
  startedAt: string | null
  finishedAt: string | null
}

export type WorkStepsSnapshot = {
  type: 'work_steps_snapshot'
  version: typeof WORK_STEPS_SNAPSHOT_VERSION
  trackerId: string
  originTurnId: string
  currentTurnId: string
  turnIds: string[]
  conversationId: string
  originAssistantMessageId: string | null
  revision: number
  source: 'agent_plan' | 'turn_runtime'
  sourceId: string
  goal: string
  status: WorkStepsOverallStatus
  headline: string
  blockedBy: WorkStepsBlocker | null
  retryRef: null
  steps: WorkStepsSnapshotStep[]
  updatedAt: string
}

export type TrackerPlanRow = {
  id: string
  conversationId: string | null
  goal: string
  status: string
  originTurnId: string | null
  originAssistantMessageId: string | null
  trackerSnapshot: unknown
  trackerRevision: number
  steps: Array<{
    id: string
    seq: number
    action: string
    status: string
    /** Set when the plan step named the tool that carries it out. */
    toolName?: string | null
    startedAt: Date | null
    doneAt: Date | null
    turnId: string | null
  }>
}

const PLAN_SELECT = {
  id: true,
  conversationId: true,
  goal: true,
  status: true,
  originTurnId: true,
  originAssistantMessageId: true,
  trackerSnapshot: true,
  trackerRevision: true,
  steps: {
    select: {
      id: true, seq: true, action: true, status: true,
      startedAt: true, doneAt: true, turnId: true,
      // The turn ticks off the step whose tool it just ran — see plan-step-advance.ts.
      toolName: true,
    },
    orderBy: { seq: 'asc' as const },
  },
} as const

function snapshotTurnIds(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const ids = (snapshot as Record<string, unknown>).turnIds
  return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Exact-linkage plan loader. Attaches ONLY when:
 * 1. the plan was created by THIS turn (`originTurnId` match), or
 * 2. this turn is already in the tracker's turn chain, or
 * 3. this turn is an explicit continuation (approval resume / "চালিয়ে যাও")
 *    of the newest still-open tracker in this conversation.
 */
export async function loadPlanForWorkTracker(
  conversationId: string,
  turnId: string | null | undefined,
  isContinuation: boolean,
): Promise<TrackerPlanRow | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    if (turnId) {
      const own = await db.agentPlan.findFirst({
        where: { conversationId, originTurnId: turnId },
        select: PLAN_SELECT,
      })
      if (own?.steps?.length) return own
    }
    const recent: TrackerPlanRow[] = await db.agentPlan.findMany({
      where: { conversationId, status: { notIn: ['abandoned'] } },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: PLAN_SELECT,
    })
    for (const plan of recent) {
      if (turnId && snapshotTurnIds(plan.trackerSnapshot).includes(turnId)) {
        return plan.steps?.length ? plan : null
      }
    }
    if (isContinuation) {
      const open = recent.find((plan) => {
        const snap = plan.trackerSnapshot as Record<string, unknown> | null
        const status = snap && typeof snap === 'object' ? snap.status : null
        return typeof status === 'string'
          && ['preparing', 'running', 'waiting_owner', 'waiting_worker', 'paused'].includes(status)
      })
      if (open?.steps?.length) return open
    }
    return null
  } catch {
    return null
  }
}

function mapStepStatus(status: string): WorkStepStatus {
  switch (status) {
    case 'done': return 'completed'
    case 'running': return 'running'
    case 'failed': return 'failed'
    case 'skipped': return 'skipped'
    default: return 'pending'
  }
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯'
const bn = (n: number): string => String(n).replace(/\d/g, (d) => BN_DIGITS[Number(d)])

/**
 * Project the durable plan rows into one full snapshot. `live` distinguishes
 * "this turn is executing right now" from a settled/terminal projection —
 * a tracker with remaining steps and no blocker is honest `paused` when
 * nothing is actually running.
 */
export function projectWorkSteps(input: {
  plan: TrackerPlanRow
  currentTurnId: string
  revision: number
  blockedBy: WorkStepsBlocker | null
  live: boolean
  now?: Date
}): WorkStepsSnapshot {
  const { plan, currentTurnId, revision, blockedBy, live } = input
  const now = input.now ?? new Date()
  const originTurnId = plan.originTurnId ?? currentTurnId
  const priorTurnIds = snapshotTurnIds(plan.trackerSnapshot)
  const turnIds = priorTurnIds.includes(currentTurnId)
    ? priorTurnIds
    : [...priorTurnIds, currentTurnId]
  if (turnIds.length === 0) turnIds.push(currentTurnId)

  const steps: WorkStepsSnapshotStep[] = plan.steps.map((s) => {
    let status = mapStepStatus(s.status)
    // A step whose row says running but that is dispatched to a worker turn
    // is waiting on that worker, not burning this turn.
    if (status === 'running' && s.turnId && s.turnId !== currentTurnId) {
      status = 'waiting_worker'
    }
    return {
      id: s.id,
      position: s.seq,
      title: s.action,
      status,
      toolCallIds: [],
      startedAt: s.startedAt ? s.startedAt.toISOString() : null,
      finishedAt: s.doneAt ? s.doneAt.toISOString() : null,
    }
  })

  const doneCount = steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length
  const failedTerminal = plan.status === 'failed'
  const allDone = steps.length > 0 && doneCount === steps.length

  let status: WorkStepsOverallStatus
  if (plan.status === 'cancelled' || plan.status === 'abandoned') status = 'cancelled'
  else if (allDone || plan.status === 'done') status = 'completed'
  else if (failedTerminal) status = 'failed'
  else if (blockedBy?.kind === 'approval' || blockedBy?.kind === 'question') status = 'waiting_owner'
  else if (blockedBy?.kind === 'worker' || blockedBy?.kind === 'queue'
    || steps.some((s) => s.status === 'waiting_worker')) status = 'waiting_worker'
  else if (blockedBy?.kind === 'global_pause') status = 'paused'
  else if (live) status = steps.some((s) => s.status === 'running') ? 'running' : 'preparing'
  else status = 'paused'

  // Blocked-owner steps: when the tracker waits on the owner, the ACTIVE step
  // (first running, else first pending) is what is waiting.
  if (status === 'waiting_owner') {
    const active = steps.find((s) => s.status === 'running') ?? steps.find((s) => s.status === 'pending')
    if (active) active.status = 'waiting_owner'
  } else if (status === 'waiting_worker') {
    const active = steps.find((s) => s.status === 'running') ?? steps.find((s) => s.status === 'pending')
    if (active) active.status = 'waiting_worker'
  }

  const running = steps.find((s) => s.status === 'running')
  const waiting = steps.find((s) => s.status === 'waiting_owner')
  const headline =
    status === 'completed' ? `${bn(steps.length)}/${bn(steps.length)} ধাপ শেষ`
    : status === 'waiting_owner' ? `আপনার সিদ্ধান্তের অপেক্ষায়${waiting ? `: ${waiting.title}` : ''}`
    : status === 'waiting_worker' ? 'Worker-এ কাজ চলছে'
    : status === 'failed' ? `${bn(doneCount)}/${bn(steps.length)} ধাপ শেষ · আটকে গেছে`
    : status === 'cancelled' ? 'বাতিল হয়েছে'
    : running ? `${bn(doneCount)}/${bn(steps.length)} ধাপ শেষ · এখন: ${running.title}`
    : `${bn(doneCount)}/${bn(steps.length)} ধাপ শেষ`

  return {
    type: 'work_steps_snapshot',
    version: WORK_STEPS_SNAPSHOT_VERSION,
    trackerId: plan.id,
    originTurnId,
    currentTurnId,
    turnIds,
    conversationId: plan.conversationId ?? '',
    originAssistantMessageId: plan.originAssistantMessageId ?? null,
    revision,
    source: 'agent_plan',
    sourceId: plan.id,
    goal: plan.goal,
    status,
    headline,
    blockedBy,
    retryRef: null,
    steps,
    updatedAt: now.toISOString(),
  }
}

/** Change test — identical trackers must not be re-sent every tool round. */
export function workStepsSignature(snapshot: WorkStepsSnapshot | null): string {
  if (!snapshot) return ''
  return [
    snapshot.trackerId,
    snapshot.status,
    snapshot.blockedBy ? `${snapshot.blockedBy.kind}:${snapshot.blockedBy.refId}` : '',
    snapshot.originAssistantMessageId ?? '',
    snapshot.currentTurnId,
    snapshot.steps.map((s) => `${s.position}${s.status[0]}`).join(''),
  ].join('|')
}

/**
 * Serialized project-and-persist for one plan tracker.
 *
 * Codex P1 rounds on PR #733: (1) two overlapping refreshes constructed the
 * same revision; (2) after atomic revision allocation, a refresh that READ
 * stale rows could still WRITE later and win the higher revision, regressing
 * waiting_worker back to running. The whole read→project→write now runs
 * inside one transaction holding a per-plan advisory lock, so every writer
 * projects from the freshest rows and revisions are both unique and ordered
 * with content.
 *
 * Returns the persisted snapshot (with its DB-assigned revision) when the
 * content actually changed, or null when unchanged/failed — callers emit
 * exactly what was persisted.
 */
export async function syncPlanTracker(
  planId: string,
  opts: {
    currentTurnId?: string
    blockedBy?: WorkStepsBlocker | null
    live?: boolean
    bindAssistantMessageId?: string | null
    now?: Date
  } = {},
): Promise<WorkStepsSnapshot | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    return await db.$transaction(async (tx: typeof db) => {
      // `pg_advisory_xact_lock` returns PostgreSQL `void`. Prisma attempts to
      // deserialize every `$queryRaw` column and rejects `void` with P2010,
      // which used to make every live plan snapshot fail open and disappear
      // before reaching the clients. Casting the result keeps the same
      // transaction-scoped lock while giving Prisma a supported wire type.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${planId}))::text AS lock_token`
      const plan: TrackerPlanRow | null = await tx.agentPlan.findUnique({
        where: { id: planId },
        select: PLAN_SELECT,
      })
      // Only plans that ever emitted a tracker participate — a plan created
      // before this feature (no origin turn, no snapshot) stays silent unless
      // the caller supplies an explicit turn.
      if (!plan || !plan.steps?.length) return null
      if (!plan.originTurnId && plan.trackerRevision === 0 && !opts.currentTurnId) return null
      const prior = parseWorkStepsSnapshot(plan.trackerSnapshot)
      const currentTurnId = opts.currentTurnId
        ?? prior?.currentTurnId ?? plan.originTurnId ?? plan.id
      let effectiveBlockedBy = opts.blockedBy !== undefined
        ? opts.blockedBy
        : (plan.steps.some((s) => s.status === 'running') ? null : (prior?.blockedBy ?? null))
      // The same advisory-locked transaction that writes the snapshot verifies
      // the referenced durable row first. A stale turn can therefore never
      // restore waiting_owner/waiting_worker after an answer or terminal worker
      // callback already cleared it; a concurrent callback waits on this plan
      // lock and its subsequent terminal snapshot wins.
      if (effectiveBlockedBy?.kind === 'approval' || effectiveBlockedBy?.kind === 'worker') {
        const action = await tx.agentPendingAction.findUnique({
          where: { id: effectiveBlockedBy.refId },
          select: { status: true },
        })
        effectiveBlockedBy = reconcileDurableWorkStepsBlocker(
          effectiveBlockedBy,
          typeof action?.status === 'string' ? action.status : null,
        )
      } else if (effectiveBlockedBy?.kind === 'question') {
        const card = await tx.agentAskCard.findUnique({
          where: { id: effectiveBlockedBy.refId },
          select: { status: true },
        })
        effectiveBlockedBy = reconcileDurableWorkStepsBlocker(
          effectiveBlockedBy,
          typeof card?.status === 'string' ? card.status : null,
        )
      }
      const snapshot = projectWorkSteps({
        plan,
        currentTurnId,
        // Placeholder — the same transaction assigns the real revision below.
        revision: plan.trackerRevision + 1,
        // A running/dispatched step contradicts a remembered owner blocker —
        // the Plan-Driver resumed past the approval, so the stale reference
        // must not keep projecting waiting_owner (Codex P2, PR #733 round 3).
        blockedBy: effectiveBlockedBy,
        live: opts.live ?? plan.steps.some((s) => s.status === 'running'),
        now: opts.now,
      })
      if (opts.bindAssistantMessageId && !plan.originAssistantMessageId) {
        snapshot.originAssistantMessageId = opts.bindAssistantMessageId
      }
      const bindingChanged = Boolean(
        snapshot.originAssistantMessageId
        && snapshot.originAssistantMessageId !== plan.originAssistantMessageId)
      if (prior && !bindingChanged
        && workStepsSignature(prior) === workStepsSignature(snapshot)) return null
      const rows: Array<{ tracker_revision: number }> = await tx.$queryRaw`
        UPDATE "agent_plans"
        SET "tracker_revision" = "tracker_revision" + 1,
            "tracker_snapshot" = jsonb_set(
              ${JSON.stringify(snapshot)}::jsonb,
              '{revision}',
              to_jsonb("tracker_revision" + 1)),
            "origin_assistant_message_id" =
              COALESCE(${snapshot.originAssistantMessageId}, "origin_assistant_message_id"),
            "origin_turn_id" = COALESCE("origin_turn_id", ${snapshot.originTurnId})
        WHERE "id" = ${planId}
        RETURNING "tracker_revision"`
      const revision = rows?.[0]?.tracker_revision
      if (typeof revision !== 'number') return null
      return { ...snapshot, revision }
    })
  } catch {
    return null
  }
}

/**
 * Fire-and-forget wrapper for plan-step writers (the Plan-Driver runs in
 * background turns the owner never streams; the app's message poll picks up
 * the refreshed snapshot). Must never break a step transition.
 */
export async function refreshPlanTrackerSnapshot(planId: string): Promise<void> {
  await syncPlanTracker(planId).catch(() => null)
}

// ── Runtime projector for UNPLANNED turns ───────────────────────────────────
//
// The owner's live test (2026-08-12) showed the gap: a complex request the
// head serves directly — without staging an AgentPlan — had no tracker at
// all. Handoff §truth-precedence sanctions a factual runtime projector using
// honest macro phases whose transitions come only from real evidence:
// the accepted turn exists, tool rounds actually ran, the honesty guard
// actually retried, the final answer was actually persisted. No invented
// fixed plan, no estimated percentage; a trivial tool-free answer emits
// nothing.

export type RuntimeWorkPhase = 'working' | 'verifying' | 'delivering' | 'settled'

export function projectRuntimeWorkSteps(input: {
  turnId: string
  conversationId: string
  goal: string
  revision: number
  phase: RuntimeWorkPhase
  completedToolRounds: number
  verificationHappened: boolean
  blockedBy: WorkStepsBlocker | null
  originAssistantMessageId?: string | null
  /**
   * The tool calls this turn actually made, in order. Each becomes its own named
   * step: the owner asked to see *what* the agent is doing, and "৩ ধাপ টুল-কাজ"
   * answers only *how much*. Names come from the same label table the live
   * "checking" strip uses, so the tracker and the strip never disagree.
   */
  toolCalls?: Array<{ id: string; toolName: string; status: 'success' | 'error' }>
  now?: Date
}): WorkStepsSnapshot {
  const now = input.now ?? new Date()
  const { phase } = input
  const steps: WorkStepsSnapshotStep[] = []
  const push = (id: string, title: string, status: WorkStepStatus) => {
    steps.push({
      id: `rt-${input.turnId}-${id}`,
      position: steps.length + 1,
      title,
      status,
      toolCallIds: [],
      startedAt: null,
      finishedAt: null,
    })
  }
  // Evidence: the persisted owner request was accepted (this turn exists).
  push('accept', 'অনুরোধ বুঝে নেওয়া', 'completed')
  // Evidence: the tool calls that actually ran, named one by one. Consecutive
  // repeats of the same tool collapse into a single step — five reads of the same
  // list is one thing being done, not five things.
  const calls = input.toolCalls ?? []
  if (calls.length) {
    // Group first, THEN judge: a retry is the same tool twice, and if the second
    // attempt failed the group failed. Dropping every outcome after the first
    // would report a success the turn did not get.
    const groups: Array<{ toolName: string; failed: boolean }> = []
    for (const call of calls) {
      const open = groups[groups.length - 1]
      if (open && open.toolName === call.toolName) {
        open.failed = call.status === 'error'
        continue
      }
      groups.push({ toolName: call.toolName, failed: call.status === 'error' })
    }
    groups.forEach((group, index) => {
      const last = index === groups.length - 1
      push(
        `tool-${index + 1}`,
        toolDisplay(group.toolName).label,
        group.failed ? 'failed' : (last && phase === 'working' ? 'running' : 'completed'),
      )
    })
  } else {
    // No per-call detail available (older callers): fall back to the honest count.
    const roundLabel = input.completedToolRounds > 1
      ? `তথ্য সংগ্রহ ও কাজ (${bn(input.completedToolRounds)} ধাপ টুল-কাজ)`
      : 'তথ্য সংগ্রহ ও কাজ'
    push('work', roundLabel, phase === 'working' ? 'running' : 'completed')
  }
  // Appears only when the honesty guard ACTUALLY retried this turn.
  if (input.verificationHappened) {
    push('verify', 'উত্তর যাচাই', phase === 'verifying' ? 'running' : 'completed')
  }
  if (phase === 'delivering' || phase === 'settled') {
    push('answer', 'উত্তর তৈরি', phase === 'settled' ? 'completed' : 'running')
  }

  const doneCount = steps.filter((s) => s.status === 'completed').length
  const failedCount = steps.filter((s) => s.status === 'failed').length
  let status: WorkStepsOverallStatus
  if (input.blockedBy?.kind === 'approval' || input.blockedBy?.kind === 'question') {
    status = 'waiting_owner'
    const active = steps.find((s) => s.status === 'running')
    if (active) active.status = 'waiting_owner'
  } else if (phase === 'settled') {
    status = 'completed'
  } else {
    status = 'running'
  }
  const running = steps.find((s) => s.status === 'running')
  const waiting = steps.find((s) => s.status === 'waiting_owner')
  // A settled turn still delivered an answer, so the overall status stays
  // `completed` — but the headline must not claim every step finished when one
  // of them failed. Saying "৪/৪ ধাপ শেষ" over a failed read is the exact kind of
  // cheerful lie this tracker exists to prevent.
  const headline =
    status === 'completed' && failedCount > 0
      ? `${bn(doneCount)}/${bn(steps.length)} ধাপ শেষ · ${bn(failedCount)}টি ধাপ ব্যর্থ`
    : status === 'completed' ? `${bn(steps.length)}/${bn(steps.length)} ধাপ শেষ`
    : status === 'waiting_owner' ? `আপনার সিদ্ধান্তের অপেক্ষায়${waiting ? `: ${waiting.title}` : ''}`
    : running ? `${bn(doneCount)}/${bn(steps.length)} ধাপ শেষ · এখন: ${running.title}`
    : `${bn(doneCount)}/${bn(steps.length)} ধাপ শেষ`

  return {
    type: 'work_steps_snapshot',
    version: WORK_STEPS_SNAPSHOT_VERSION,
    trackerId: `turn:${input.turnId}`,
    originTurnId: input.turnId,
    currentTurnId: input.turnId,
    turnIds: [input.turnId],
    conversationId: input.conversationId,
    originAssistantMessageId: input.originAssistantMessageId ?? null,
    revision: input.revision,
    source: 'turn_runtime',
    sourceId: input.turnId,
    goal: input.goal,
    status,
    headline,
    blockedBy: input.blockedBy,
    retryRef: null,
    steps,
    updatedAt: now.toISOString(),
  }
}

/** Parse a stored snapshot; null when malformed or a future major version. */
export function parseWorkStepsSnapshot(value: unknown): WorkStepsSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.type !== 'work_steps_snapshot' || raw.version !== WORK_STEPS_SNAPSHOT_VERSION) return null
  if (typeof raw.trackerId !== 'string' || typeof raw.revision !== 'number') return null
  if (!Array.isArray(raw.steps)) return null
  return raw as unknown as WorkStepsSnapshot
}
