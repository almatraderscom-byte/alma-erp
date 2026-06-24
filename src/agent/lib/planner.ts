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
export type AutodriveState = 'idle' | 'driving' | 'blocked' | 'done' | 'failed' | 'abandoned'

export const TERMINAL_AUTODRIVE_STATES: ReadonlySet<AutodriveState> = new Set<AutodriveState>([
  'done',
  'failed',
  'abandoned',
])

export interface Plan {
  id: string
  goal: string
  status: 'draft' | 'approved' | 'executing' | 'done' | 'failed' | 'cancelled'
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
