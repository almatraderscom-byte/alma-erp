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
  dependsOn: string[]
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  result?: unknown
  error?: string
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
  /** Whole-taka autodrive spend on this plan (daily cost-cap input). */
  costTaka: number
}

/**
 * Create a plan with ordered steps. Returns the persisted plan.
 */
export async function createPlan(opts: {
  goal: string
  steps: { action: string; toolName?: string; dependsOn?: string[] }[]
  conversationId?: string
  businessId?: string
}): Promise<Plan> {
  const plan = await db.agentPlan.create({
    data: {
      goal: opts.goal,
      conversationId: opts.conversationId ?? null,
      businessId: opts.businessId ?? 'ALMA_LIFESTYLE',
      status: 'draft',
      steps: {
        create: opts.steps.map((s, i) => ({
          seq: i + 1,
          action: s.action,
          toolName: s.toolName ?? null,
          dependsOn: s.dependsOn ?? [],
          status: 'pending',
        })),
      },
    },
    include: { steps: { orderBy: { seq: 'asc' } } },
  })

  return dbPlanToDto(plan)
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
 * Mark a step as done with its result.
 */
export async function markStepDone(stepId: string, result?: unknown): Promise<void> {
  await db.agentPlanStep.update({
    where: { id: stepId },
    data: {
      status: 'done',
      result: result !== undefined ? JSON.parse(JSON.stringify(result)) : null,
      doneAt: new Date(),
    },
  })
}

/**
 * Mark a step as failed.
 */
export async function markStepFailed(stepId: string, error: string): Promise<void> {
  await db.agentPlanStep.update({
    where: { id: stepId },
    data: { status: 'failed', error, doneAt: new Date() },
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
    data: { autodriveState: 'abandoned', status: 'cancelled', nextTickAt: null },
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
    addCostTaka?: number
    nextTickAt?: Date | null
    attempt?: 'increment' | 'reset' | 'keep'
    now?: Date
  } = {},
): Promise<void> {
  const now = opts.now ?? new Date()
  const data: Record<string, unknown> = { lastDrivenAt: now }
  if (opts.addCostTaka && opts.addCostTaka > 0) {
    data.costTaka = { increment: Math.round(opts.addCostTaka) }
  }
  if (opts.nextTickAt !== undefined) data.nextTickAt = opts.nextTickAt
  if (opts.attempt === 'increment') data.attemptCount = { increment: 1 }
  else if (opts.attempt === 'reset') data.attemptCount = 0
  await db.agentPlan.update({ where: { id: planId }, data })
}

/**
 * Get steps that are ready to execute (all dependencies done).
 */
export function getReadySteps(plan: Pick<Plan, 'steps'>): PlanStep[] {
  const doneIds = new Set(
    plan.steps.filter(s => s.status === 'done').map(s => s.id),
  )
  return plan.steps.filter(s => {
    if (s.status !== 'pending') return false
    return s.dependsOn.every(depId => doneIds.has(depId))
  })
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
 * window (next_tick_at) has elapsed. Read-only — Phase A consumes this in shadow
 * mode (compute the next ready step, log what it WOULD do, mutate nothing).
 *
 * Ordered oldest-driven-first so no single plan can starve the others.
 */
export async function loadDrivablePlans(opts?: { limit?: number; now?: Date }): Promise<Plan[]> {
  const now = opts?.now ?? new Date()
  const limit = opts?.limit ?? 20
  const rows = await db.agentPlan.findMany({
    where: {
      // 'escalated' is intentionally excluded — it waits on an explicit owner
      // decision and must NOT auto-resume (that was the re-escalation loop).
      autodriveState: { in: ['driving', 'blocked'] },
      OR: [{ nextTickAt: null }, { nextTickAt: { lte: now } }],
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
  steps: Array<{
    id: string
    action: string
    toolName?: string | null
    dependsOn: string[]
    status: string
    result?: unknown
    error?: string | null
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
    steps: plan.steps.map(s => ({
      id: s.id,
      action: s.action,
      toolName: s.toolName ?? undefined,
      dependsOn: s.dependsOn,
      status: s.status as PlanStep['status'],
      result: s.result ?? undefined,
      error: s.error ?? undefined,
    })),
  }
}
