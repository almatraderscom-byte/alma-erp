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
 * Durable, monotonic persistence: the snapshot lands only if its revision is
 * newer than the stored one, so replay/poll overlap can never regress a
 * terminal state. Returns true when this revision won.
 */
export async function persistWorkStepsSnapshot(snapshot: WorkStepsSnapshot): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const updated = await db.agentPlan.updateMany({
      where: { id: snapshot.trackerId, trackerRevision: { lt: snapshot.revision } },
      data: {
        trackerSnapshot: snapshot,
        trackerRevision: snapshot.revision,
        ...(snapshot.originAssistantMessageId
          ? { originAssistantMessageId: snapshot.originAssistantMessageId }
          : {}),
        ...(snapshot.originTurnId && { originTurnId: snapshot.originTurnId }),
      },
    })
    return updated.count > 0
  } catch {
    return false
  }
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
  // Evidence: tool rounds actually executed (the projector is only invoked
  // once the first round completed).
  const roundLabel = input.completedToolRounds > 1
    ? `তথ্য সংগ্রহ ও কাজ (${bn(input.completedToolRounds)} ধাপ টুল-কাজ)`
    : 'তথ্য সংগ্রহ ও কাজ'
  push('work', roundLabel, phase === 'working' ? 'running' : 'completed')
  // Appears only when the honesty guard ACTUALLY retried this turn.
  if (input.verificationHappened) {
    push('verify', 'উত্তর যাচাই', phase === 'verifying' ? 'running' : 'completed')
  }
  if (phase === 'delivering' || phase === 'settled') {
    push('answer', 'উত্তর তৈরি', phase === 'settled' ? 'completed' : 'running')
  }

  const doneCount = steps.filter((s) => s.status === 'completed').length
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
  const headline =
    status === 'completed' ? `${bn(steps.length)}/${bn(steps.length)} ধাপ শেষ`
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

/**
 * Refresh the durable tracker snapshot after a plan-step state change.
 *
 * Owner live test (2026-08-13): the Plan-Driver executes steps in BACKGROUND
 * worker turns, but snapshots were only projected during the owner turn — the
 * dock froze at ০/৫ while steps actually completed. Every step writer now
 * refreshes the persisted snapshot; the app's message poll then merges the
 * higher revision (no live stream required). Fire-and-forget by design: a
 * tracker refresh must never break a step transition.
 */
export async function refreshPlanTrackerSnapshot(planId: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const plan: TrackerPlanRow | null = await db.agentPlan.findUnique({
      where: { id: planId },
      select: PLAN_SELECT,
    })
    // Only plans that ever emitted a tracker participate — a plan created
    // before this feature (no origin turn, no snapshot) stays silent.
    if (!plan || !plan.steps?.length) return
    if (!plan.originTurnId && plan.trackerRevision === 0) return
    const prior = parseWorkStepsSnapshot(plan.trackerSnapshot)
    const currentTurnId = prior?.currentTurnId ?? plan.originTurnId ?? plan.id
    const snapshot = projectWorkSteps({
      plan,
      currentTurnId,
      revision: plan.trackerRevision + 1,
      blockedBy: prior?.blockedBy ?? null,
      // The driver is actively moving steps; running/waiting_worker/completed
      // all derive from the durable rows themselves.
      live: plan.steps.some((s) => s.status === 'running'),
    })
    if (prior && workStepsSignature(prior) === workStepsSignature(snapshot)) return
    await persistWorkStepsSnapshot(snapshot)
  } catch { /* never break the step writer */ }
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
