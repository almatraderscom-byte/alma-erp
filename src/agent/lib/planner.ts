/**
 * Agent planner — creates, persists, and executes structured plans
 * for complex multi-step tasks.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface PlanStep {
  id: string
  action: string
  toolName?: string
  /** DB step ids (resolved from logical "step-1" keys at create time). */
  dependsOn: string[]
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  result?: unknown
  error?: string
  startedAt?: Date
  doneAt?: Date
  /** S0 retry state — per STEP, so one failure no longer kills the plan. */
  attemptCount: number
  maxAttempts: number
  nextAttemptAt?: Date
  /** S0 queue mode — the worker turn this step is waiting on. */
  turnId?: string
  dispatchedAt?: Date
}

/**
 * Plan-Driver lifecycle (autonomous pursue-until-completion).
 *   idle      — not under the driver yet (or hand-driven only)
 *   driving   — the driver is actively re-driving this plan tick by tick
 *   blocked   — waiting on an owner approval / external signal
 *   done|failed|abandoned — terminal; the driver never touches it again
 */
/**
 * Autodrive lifecycle:
 *  - 'driving'   → actively advancing, auto-picked each due tick.
 *  - 'blocked'   → waiting on an owner APPROVAL card; auto-resumes the moment the
 *                  approval clears (still loaded by the tick, re-checks each time).
 *  - 'escalated' → waiting on an owner DECISION (cost cap hit, too many stalls, or
 *                  the completion gate said "not done" with no auto-repair). This
 *                  state is deliberately NOT auto-picked by the tick — otherwise a
 *                  capped/stuck plan would re-hit the same wall every backoff and
 *                  spam the owner forever. It stays VISIBLE in the Plan-Drive panel
 *                  (never dropped) until the owner acts, which re-enrols it.
 *  - terminal    → 'done' | 'failed' | 'abandoned'.
 */
export type AutodriveState = 'idle' | 'driving' | 'blocked' | 'escalated' | 'done' | 'failed' | 'abandoned'

export const TERMINAL_AUTODRIVE_STATES: ReadonlySet<AutodriveState> = new Set<AutodriveState>([
  'done',
  'failed',
  'abandoned',
])

/** States that are still "in flight" for the owner — shown in the Plan-Drive panel. */
export const VISIBLE_AUTODRIVE_STATES: ReadonlySet<AutodriveState> = new Set<AutodriveState>([
  'driving',
  'blocked',
  'escalated',
])

export interface Plan {
  id: string
  goal: string
  status: 'draft' | 'approved' | 'executing' | 'done' | 'failed' | 'cancelled'
  /** Owner conversation this plan belongs to — the executor drives steps here. */
  conversationId?: string | null
  /** Business scope ('ALMA_LIFESTYLE' | 'ALMA_TRADING'). */
  businessId: string
  steps: PlanStep[]
  selfCheckNote?: string
  /** Plain-language "what counts as DONE" — read by the completion gate. */
  doneCriteria?: string
  autodriveState: AutodriveState
  attemptCount: number
  maxAttempts: number
  nextTickAt?: Date
  lastDrivenAt?: Date
  /** Whole-taka autodrive spend on this plan (owner-facing display). */
  costTaka: number
  /** Precise lifetime spend in milli-taka (1৳ = 1000) — the cap arithmetic input. */
  costMilliTaka: number
  /** Spend inside the Asia/Dhaka day named by costDay. */
  costMilliTakaDay: number
  costDay?: string | null
  /** Durable timing used by the native Background Tasks live/history UI. */
  createdAt?: Date
  updatedAt?: Date
  completedAt?: Date
}

/**
 * Logical step keys an author may use in `dependsOn` — "step-1" is the FIRST
 * step, "step-2" the second, and so on (the make_plan tool documents exactly
 * this). Anything else is treated as a DB id and passed through.
 */
const LOGICAL_STEP_KEY = /^step-(\d+)$/i

/**
 * Create a plan with ordered steps. Returns the persisted plan.
 *
 * S0 FIX — dependency resolution. Authors write logical keys ("step-1"), but
 * `getReadySteps` compares `dependsOn` against DB uuids. Every ordered plan ever
 * created was therefore structurally dead: no dependency could ever be satisfied,
 * so a diagnose → fix → verify chain (which is entirely dependency-shaped) could
 * never advance past its first step. We now translate the logical keys into the
 * real ids in the same transaction that creates them.
 */
export async function createPlan(opts: {
  goal: string
  steps: { action: string; toolName?: string; dependsOn?: string[]; maxAttempts?: number }[]
  conversationId?: string
  businessId?: string
  /// Build 103 Issue 3 — the turn that accepted the owner request this plan
  /// serves. The work-step tracker attaches by THIS exact link, never by
  /// "newest plan in the conversation".
  originTurnId?: string
}): Promise<Plan> {
  const plan = await db.agentPlan.create({
    data: {
      goal: opts.goal,
      conversationId: opts.conversationId ?? null,
      businessId: opts.businessId ?? 'ALMA_LIFESTYLE',
      originTurnId: opts.originTurnId ?? null,
      status: 'draft',
      steps: {
        create: opts.steps.map((s, i) => ({
          seq: i + 1,
          action: s.action,
          toolName: s.toolName ?? null,
          // Written empty first; resolved to DB ids immediately below, once the
          // ids exist. Storing the logical keys would leave them unresolvable.
          dependsOn: [],
          status: 'pending',
          ...(s.maxAttempts ? { maxAttempts: s.maxAttempts } : {}),
        })),
      },
    },
    include: { steps: { orderBy: { seq: 'asc' } } },
  })

  const bySeq: string[] = plan.steps.map((s: { id: string }) => s.id)
  const resolved = opts.steps.map((s) => resolveDependsOn(s.dependsOn ?? [], bySeq))
  await Promise.all(
    resolved.map((deps, i) =>
      deps.length === 0
        ? null
        : db.agentPlanStep.update({ where: { id: bySeq[i] }, data: { dependsOn: deps } }),
    ).filter(Boolean),
  )
  for (let i = 0; i < plan.steps.length; i++) plan.steps[i].dependsOn = resolved[i]

  return dbPlanToDto(plan)
}

/**
 * Translate one step's dependsOn list into DB ids. Pure — unit-tested directly.
 * Unknown keys are dropped rather than kept: a dependency that can never resolve
 * would silently freeze the plan forever, which is the exact bug this fixes.
 */
export function resolveDependsOn(deps: string[], stepIdsBySeq: string[]): string[] {
  const out: string[] = []
  for (const dep of deps) {
    const m = LOGICAL_STEP_KEY.exec(dep.trim())
    if (m) {
      const idx = Number(m[1]) - 1
      const id = stepIdsBySeq[idx]
      if (id) out.push(id)
      continue
    }
    if (stepIdsBySeq.includes(dep)) out.push(dep) // already a real id
  }
  return [...new Set(out)]
}

/**
 * Load a plan by ID.
 */
export async function loadPlan(planId: string): Promise<Plan | null> {
  const plan = await db.agentPlan.findUnique({
    where: { id: planId },
    include: { steps: { orderBy: { seq: 'asc' } } },
  })
  return plan ? dbPlanToDto(plan) : null
}

/**
 * Update plan status.
 */
export async function updatePlanStatus(
  planId: string,
  status: Plan['status'],
  selfCheckNote?: string,
): Promise<void> {
  const data: Record<string, unknown> = { status }
  if (status === 'done' || status === 'failed') {
    data.completedAt = new Date()
  }
  if (selfCheckNote !== undefined) {
    data.selfCheckNote = selfCheckNote
  }
  await db.agentPlan.update({ where: { id: planId }, data })
}

/**
 * Mark a step as running.
 */
export async function markStepRunning(stepId: string): Promise<void> {
  await db.agentPlanStep.update({
    where: { id: stepId },
    data: { status: 'running', startedAt: new Date() },
  })
}

/**
 * Mark a step as done with its result. Clears the dispatch fields — a done step
 * is never waiting on a turn.
 */
export async function markStepDone(stepId: string, result?: unknown): Promise<void> {
  await db.agentPlanStep.update({
    where: { id: stepId },
    data: {
      status: 'done',
      result: result !== undefined ? JSON.parse(JSON.stringify(result)) : null,
      doneAt: new Date(),
      turnId: null,
      dispatchedAt: null,
    },
  })
}

/** Backoff before a failed step may be retried: 2, 8, 18 … minutes. */
export function stepRetryDelayMs(attemptCount: number): number {
  const n = Math.max(1, attemptCount)
  return Math.min(2 * n * n, 60) * 60_000
}

/**
 * Mark a step as failed and count the attempt.
 *
 * S0 FIX — a failed step used to be terminal: `getReadySteps` only ever returned
 * 'pending', so the plan had nothing ready on the next tick and died at
 * 'escalated-stuck' after ONE failure (the plan-level maxAttempts was
 * unreachable). The attempt is now recorded on the step and a retry window is
 * scheduled; only when the step's own ceiling is reached does it stay failed.
 */
export async function markStepFailed(stepId: string, error: string, now = new Date()): Promise<void> {
  const step = await db.agentPlanStep.findUnique({
    where: { id: stepId },
    select: { attemptCount: true, maxAttempts: true },
  })
  const attemptCount = (step?.attemptCount ?? 0) + 1
  const maxAttempts = step?.maxAttempts ?? 3
  await db.agentPlanStep.update({
    where: { id: stepId },
    data: {
      status: 'failed',
      error,
      doneAt: now,
      attemptCount,
      nextAttemptAt: attemptCount < maxAttempts ? new Date(now.getTime() + stepRetryDelayMs(attemptCount)) : null,
      turnId: null,
      dispatchedAt: null,
    },
  })
}

/**
 * A step whose action needs the owner (approval card, credential) goes BACK to
 * 'pending' rather than sitting in 'running'.
 *
 * S0 FIX — the driver used to leave a blocked step 'running' while it parked the
 * plan. `getReadySteps` can never pick a 'running' step, so approving the card
 * resumed a plan that then had nothing to do and escalated as "stuck": approval
 * deadlocked the plan it was meant to unblock. The attempt counter is NOT
 * touched — waiting for Boss is not a failure.
 */
export async function markStepBlocked(stepId: string): Promise<void> {
  await db.agentPlanStep.update({
    where: { id: stepId },
    data: { status: 'pending', turnId: null, dispatchedAt: null, nextAttemptAt: null },
  })
}

/** Queue mode — the step is now waiting on a worker turn (reaped next tick). */
export async function markStepDispatched(stepId: string, turnId: string, now = new Date()): Promise<void> {
  await db.agentPlanStep.update({
    where: { id: stepId },
    data: { status: 'running', turnId, dispatchedAt: now, startedAt: now },
  })
}

/** Steps currently waiting on a dispatched worker turn (reap input). */
export function getDispatchedSteps(plan: Pick<Plan, 'steps'>): PlanStep[] {
  return plan.steps.filter((s) => s.status === 'running' && Boolean(s.turnId))
}

/**
 * toolName marker on steps the auto-repair driver appended (Phase C). Lets the
 * driver count how many corrective rounds a plan has already had so it can cap
 * them and never re-plan forever.
 */
export const AUTOREPAIR_TOOL = '__autorepair__'

/** How many corrective steps the auto-repair driver has already appended to a plan. */
export function countRepairSteps(plan: Pick<Plan, 'steps'>): number {
  return plan.steps.filter((s) => s.toolName === AUTOREPAIR_TOOL).length
}

/**
 * Append one corrective step to a plan (Phase C auto-repair). The new step is
 * pending, depends on nothing (immediately ready), and is tagged AUTOREPAIR_TOOL so
 * the driver can cap repair rounds. The executor runs it through the SAME audited
 * head-turn path as any other step, so no new execution surface is introduced.
 */
export async function appendCorrectiveStep(planId: string, action: string): Promise<void> {
  const agg = await db.agentPlanStep.aggregate({ where: { planId }, _max: { seq: true } })
  const nextSeq = (agg?._max?.seq ?? 0) + 1
  await db.agentPlanStep.create({
    data: {
      planId,
      seq: nextSeq,
      action,
      toolName: AUTOREPAIR_TOOL,
      dependsOn: [],
      status: 'pending',
    },
  })
}

// ── Plan-Driver mutations (Phase B — autodrive lifecycle) ───────────────────

/**
 * Enroll a plan under the autonomous driver. Sets it 'driving', records the
 * plain-language done-criteria the completion gate reads, and (optionally) the
 * per-plan attempt ceiling. Idempotent — re-enrolling just refreshes the fields.
 */
export async function enrollPlanForAutodrive(
  planId: string,
  opts: { doneCriteria?: string; maxAttempts?: number } = {},
): Promise<void> {
  const data: Record<string, unknown> = {
    autodriveState: 'driving',
    status: 'executing',
    nextTickAt: new Date(), // eligible on the very next tick
  }
  if (opts.doneCriteria !== undefined) data.doneCriteria = opts.doneCriteria
  if (opts.maxAttempts !== undefined) data.maxAttempts = opts.maxAttempts
  await db.agentPlan.update({ where: { id: planId }, data })
}

/**
 * Owner lifts an escalated/blocked plan back into the drive loop (Live Desk
 * "আবার চালাও"). Clears the stall counter so a fresh attempt budget applies,
 * wipes the self-check note, and schedules an immediate tick. The per-plan cost
 * override (if the owner granted more budget) is set separately in autodrive-config.
 */
export async function resumeAutodrive(planId: string): Promise<void> {
  // "আবার চালাও" restarts the time budget too — otherwise an old plan escalates
  // again on its first tick and the button does nothing (owner-visible bug the
  // day G6 shipped).
  try {
    const { markBudgetRestart } = await import('@/agent/lib/plan-driver/plan-delivery')
    await markBudgetRestart(planId)
  } catch { /* budget bookkeeping must never block a resume */ }
  await db.agentPlan.update({
    where: { id: planId },
    data: {
      autodriveState: 'driving',
      status: 'executing',
      attemptCount: 0,
      nextTickAt: new Date(),
      selfCheckNote: null,
    },
  })
}

/** Owner drops a plan from autodrive (Live Desk "বাদ দাও") — terminal, never re-picked. */
export async function abandonAutodrive(planId: string): Promise<void> {
  await db.agentPlan.update({
    where: { id: planId },
    data: {
      autodriveState: 'abandoned',
      status: 'cancelled',
      nextTickAt: null,
      completedAt: new Date(),
    },
  })
}

/**
 * Transition a plan's autodrive_state (and optionally schedule the next tick /
 * leave a self-check note). Terminal states (done/failed/abandoned) clear the
 * next-tick so the driver never re-picks them.
 */
export async function setAutodriveState(
  planId: string,
  state: AutodriveState,
  opts: { nextTickAt?: Date | null; selfCheckNote?: string } = {},
): Promise<void> {
  const data: Record<string, unknown> = { autodriveState: state }
  if (TERMINAL_AUTODRIVE_STATES.has(state)) {
    data.nextTickAt = null
    data.completedAt = new Date()
  } else if (opts.nextTickAt !== undefined) {
    data.nextTickAt = opts.nextTickAt
  }
  if (opts.selfCheckNote !== undefined) data.selfCheckNote = opts.selfCheckNote
  await db.agentPlan.update({ where: { id: planId }, data })
}

/**
 * Record one drive tick: always stamps last_driven_at, adds this tick's whole-taka
 * spend to the running total, and (optionally) schedules the next tick via backoff.
 *
 * attempt_count is a STALL counter, not a step counter — `attempt: 'increment'` on
 * a stall (failed/blocked/not-done), `attempt: 'reset'` on real progress (a step
 * just completed). This way a long plan that keeps advancing never escalates, but
 * one stuck at the same point escalates after maxAttempts consecutive stalls.
 */
export async function recordDriveTick(
  planId: string,
  opts: {
    /** Spend to add, in MILLI-taka (1৳ = 1000). Whole-taka rounding charged 1৳ to every sub-taka turn. */
    addCostMilliTaka?: number
    nextTickAt?: Date | null
    attempt?: 'increment' | 'reset' | 'keep'
    now?: Date
  } = {},
): Promise<void> {
  const now = opts.now ?? new Date()
  const data: Record<string, unknown> = { lastDrivenAt: now }

  const add = Math.max(0, Math.round(opts.addCostMilliTaka ?? 0))
  if (add > 0) {
    // Day bucket: read-then-write (plans tick a few times a minute at most, and
    // Prisma cannot express "increment IF the day matches" in one statement).
    const today = dhakaDayKey(now)
    const row = await db.agentPlan.findUnique({
      where: { id: planId },
      select: { costDay: true, costMilliTakaDay: true, costMilliTaka: true },
    })
    const sameDay = row?.costDay === today
    data.costMilliTaka = { increment: add }
    data.costMilliTakaDay = sameDay ? (row?.costMilliTakaDay ?? 0) + add : add
    data.costDay = today
    // Whole-taka mirror kept in step for the existing owner-facing panels.
    data.costTaka = Math.floor(((row?.costMilliTaka ?? 0) + add) / 1000)
  }

  if (opts.nextTickAt !== undefined) data.nextTickAt = opts.nextTickAt
  if (opts.attempt === 'increment') data.attemptCount = { increment: 1 }
  else if (opts.attempt === 'reset') data.attemptCount = 0
  await db.agentPlan.update({ where: { id: planId }, data })
}

/** Asia/Dhaka (UTC+6) calendar day key — no Intl, matching quiet-hours' fix. */
export function dhakaDayKey(now = new Date()): string {
  const d = new Date(now.getTime() + 6 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

/**
 * Get steps that are ready to execute: all dependencies done AND either
 *  - pending, or
 *  - failed but still under its own attempt ceiling and past its retry window.
 *
 * The retry branch is the S0 fix — see markStepFailed.
 */
export function getReadySteps(plan: Pick<Plan, 'steps'>, now = new Date()): PlanStep[] {
  const doneIds = new Set(
    plan.steps.filter(s => s.status === 'done').map(s => s.id),
  )
  const retryable = (s: PlanStep) =>
    s.status === 'failed'
    && s.attemptCount < s.maxAttempts
    && (!s.nextAttemptAt || s.nextAttemptAt.getTime() <= now.getTime())

  return plan.steps.filter(s => {
    if (s.status !== 'pending' && !retryable(s)) return false
    return s.dependsOn.every(depId => doneIds.has(depId))
  })
}

/** A step that has exhausted its own retries — the plan cannot advance past it. */
export function hasExhaustedStep(plan: Pick<Plan, 'steps'>): boolean {
  return plan.steps.some((s) => s.status === 'failed' && s.attemptCount >= s.maxAttempts)
}

/**
 * Check if plan has any failed steps.
 */
export function hasFailed(plan: Pick<Plan, 'steps'>): boolean {
  return plan.steps.some(s => s.status === 'failed')
}

/**
 * Self-check: verify all steps marked done vs the goal.
 * Returns a gap assessment.
 */
export function selfCheck(plan: Pick<Plan, 'steps'>): {
  allDone: boolean
  completedCount: number
  totalCount: number
  failedSteps: string[]
  pendingSteps: string[]
} {
  const completed = plan.steps.filter(s => s.status === 'done')
  const failed = plan.steps.filter(s => s.status === 'failed')
  const pending = plan.steps.filter(s => s.status === 'pending' || s.status === 'running')

  return {
    allDone: failed.length === 0 && pending.length === 0,
    completedCount: completed.length,
    totalCount: plan.steps.length,
    failedSteps: failed.map(s => s.action),
    pendingSteps: pending.map(s => s.action),
  }
}

/**
 * Load plans the driver may act on: non-terminal autodrive_state whose backoff
 * window (next_tick_at) has elapsed. The tick route hands each to drivePlan for one
 * bounded advance.
 *
 * Ordered oldest-driven-first so no single plan can starve the others.
 */
export async function loadDrivablePlans(opts?: { limit?: number; now?: Date }): Promise<Plan[]> {
  const now = opts?.now ?? new Date()
  const limit = opts?.limit ?? 20
  const rows = await db.agentPlan.findMany({
    where: {
      OR: [
        {
          autodriveState: { in: ['driving', 'blocked'] },
          OR: [{ nextTickAt: null }, { nextTickAt: { lte: now } }],
        },
        {
          // An escalation that waits on an OWNER DECISION clears next_tick_at, so
          // it stays parked (that was the re-escalation loop). An escalation the
          // engine can recover from on its own — one that deliberately scheduled a
          // next tick — is re-admitted here. Without this, a recoverable stall was
          // indistinguishable from one needing Boss, and both waited for him.
          autodriveState: 'escalated',
          nextTickAt: { not: null, lte: now },
        },
      ],
    },
    include: { steps: { orderBy: { seq: 'asc' } } },
    orderBy: [{ lastDrivenAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  })
  return rows.map(dbPlanToDto)
}

/**
 * Load every plan the owner should SEE in the Plan-Drive panel — all non-terminal
 * autodrive plans (driving / blocked / escalated), regardless of the backoff
 * window. This is the "never falls through the cracks" guarantee: even a plan
 * parked until tomorrow, or escalated for an owner decision, stays on screen until
 * it is genuinely done or the owner abandons it. Read-only.
 */
export async function loadVisiblePlanDrives(opts?: { limit?: number }): Promise<Plan[]> {
  const limit = opts?.limit ?? 50
  const rows = await db.agentPlan.findMany({
    where: { autodriveState: { in: ['driving', 'blocked', 'escalated'] } },
    include: { steps: { orderBy: { seq: 'asc' } } },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  })
  return rows.map(dbPlanToDto)
}

/**
 * Recent terminal autonomous plans for the owner-facing Background Tasks history.
 * This is deliberately separate from daily todos: a finished plan retains the
 * original task input, step results, failure reason, and durable timestamps.
 */
export async function loadFinishedPlanDrives(opts?: { limit?: number }): Promise<Plan[]> {
  const limit = opts?.limit ?? 20
  const rows = await db.agentPlan.findMany({
    where: { autodriveState: { in: ['done', 'failed', 'abandoned'] } },
    include: { steps: { orderBy: { seq: 'asc' } } },
    orderBy: [{ completedAt: 'desc' }, { updatedAt: 'desc' }],
    take: limit,
  })
  return rows.map(dbPlanToDto)
}

/**
 * Format plan for display (Bangla).
 */
export function formatPlanForDisplay(plan: Plan): string {
  const statusIcon = (s: string) => {
    switch (s) {
      case 'done': return '✅'
      case 'failed': return '❌'
      case 'running': return '🔄'
      case 'skipped': return '⏭️'
      default: return '⬜'
    }
  }

  const lines = [`📋 **Plan: ${plan.goal}** (${plan.status})`, '']
  for (const step of plan.steps) {
    const deps = step.dependsOn.length > 0 ? ` (depends: ${step.dependsOn.join(', ')})` : ''
    lines.push(`${statusIcon(step.status)} ${step.action}${deps}`)
    if (step.error) lines.push(`   ↳ Error: ${step.error}`)
  }

  if (plan.selfCheckNote) {
    lines.push('', `📝 Self-check: ${plan.selfCheckNote}`)
  }

  return lines.join('\n')
}

// ── Internal helpers ────────────────────────────────────────────────────────

interface DbPlan {
  id: string
  goal: string
  status: string
  conversationId?: string | null
  businessId?: string | null
  selfCheckNote?: string | null
  doneCriteria?: string | null
  autodriveState?: string | null
  attemptCount?: number | null
  maxAttempts?: number | null
  nextTickAt?: Date | null
  lastDrivenAt?: Date | null
  costTaka?: number | null
  costMilliTaka?: number | null
  costMilliTakaDay?: number | null
  costDay?: string | null
  createdAt?: Date | null
  updatedAt?: Date | null
  completedAt?: Date | null
  steps: Array<{
    id: string
    action: string
    toolName?: string | null
    dependsOn: string[]
    status: string
    result?: unknown
    error?: string | null
    startedAt?: Date | null
    doneAt?: Date | null
    attemptCount?: number | null
    maxAttempts?: number | null
    nextAttemptAt?: Date | null
    turnId?: string | null
    dispatchedAt?: Date | null
  }>
}

function dbPlanToDto(plan: DbPlan): Plan {
  return {
    id: plan.id,
    goal: plan.goal,
    status: plan.status as Plan['status'],
    conversationId: plan.conversationId ?? null,
    businessId: plan.businessId ?? 'ALMA_LIFESTYLE',
    selfCheckNote: plan.selfCheckNote ?? undefined,
    doneCriteria: plan.doneCriteria ?? undefined,
    autodriveState: (plan.autodriveState ?? 'idle') as AutodriveState,
    attemptCount: plan.attemptCount ?? 0,
    maxAttempts: plan.maxAttempts ?? 5,
    nextTickAt: plan.nextTickAt ?? undefined,
    lastDrivenAt: plan.lastDrivenAt ?? undefined,
    costTaka: plan.costTaka ?? 0,
    costMilliTaka: plan.costMilliTaka ?? 0,
    costMilliTakaDay: plan.costMilliTakaDay ?? 0,
    costDay: plan.costDay ?? null,
    createdAt: plan.createdAt ?? undefined,
    updatedAt: plan.updatedAt ?? undefined,
    completedAt: plan.completedAt ?? undefined,
    steps: plan.steps.map(s => ({
      id: s.id,
      action: s.action,
      toolName: s.toolName ?? undefined,
      dependsOn: s.dependsOn,
      status: s.status as PlanStep['status'],
      result: s.result ?? undefined,
      error: s.error ?? undefined,
      startedAt: s.startedAt ?? undefined,
      doneAt: s.doneAt ?? undefined,
      attemptCount: s.attemptCount ?? 0,
      maxAttempts: s.maxAttempts ?? 3,
      nextAttemptAt: s.nextAttemptAt ?? undefined,
      turnId: s.turnId ?? undefined,
      dispatchedAt: s.dispatchedAt ?? undefined,
    })),
  }
}

/**
 * The newest plan for a conversation, projected for the chat's live checklist.
 * Read-only, indexed on `conversationId`, and fail-open to null — a checklist
 * that cannot load must never take a turn down.
 */
export async function loadLatestPlanProgress(conversationId: string): Promise<{
  planId: string
  goal: string
  rows: Array<{ seq: number; action: string; status: string }>
} | null> {
  try {
    const plan = await db.agentPlan.findFirst({
      where: { conversationId, status: { notIn: ['abandoned'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        goal: true,
        steps: { select: { seq: true, action: true, status: true }, orderBy: { seq: 'asc' } },
      },
    })
    if (!plan || !plan.steps?.length) return null
    return { planId: plan.id, goal: plan.goal, rows: plan.steps }
  } catch {
    return null
  }
}
