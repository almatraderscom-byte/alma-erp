/**
 * Plan-Drive visibility view — the read model behind the owner-facing "Plan-Drive"
 * panel (Phase C). Mirrors the Day-Shift session: the owner watches the agent
 * pursue each plan step-by-step, live, instead of it all happening invisibly in the
 * background.
 *
 * It assembles, for every in-flight plan (driving / blocked / escalated), a compact
 * status the UI can render as a timeline: per-step dots, a one-line "what's
 * happening now", the self-scheduled next wake-up, spend so far, and — for parked
 * plans — exactly what the agent is waiting on. Read-only; never mutates.
 *
 * "Never falls through the cracks": this lists plans regardless of their backoff
 * window, so a plan parked until tomorrow (or escalated for a decision) stays on
 * screen every day until it is genuinely done or the owner abandons it.
 */
import {
  type Plan,
  type PlanStep,
  type AutodriveState,
  loadVisiblePlanDrives,
} from '@/agent/lib/planner'
import { getAutodriveConfig } from '@/agent/lib/autodrive-config'

export type PlanDrivePhase =
  | 'driving' // actively advancing
  | 'waiting-approval' // parked on an approval card
  | 'needs-decision' // escalated — owner must act (cap / stalls / gate)
  | 'done'

export interface PlanDriveStepView {
  id: string
  action: string
  status: PlanStep['status']
  toolName?: string
  /** Short human result/error line for the expanded view. */
  detail?: string
}

export interface PlanDriveView {
  planId: string
  goal: string
  conversationId: string | null
  autodriveState: AutodriveState
  phase: PlanDrivePhase
  /** Steps 0..n with their status — drives the dot timeline. */
  steps: PlanDriveStepView[]
  doneCount: number
  totalCount: number
  /** The step the agent is on / about to run, in plain Bangla (for the live line). */
  currentLine: string
  /** Why it is parked, when escalated/blocked (selfCheckNote). */
  waitingReason?: string
  /** ISO timestamp of the self-scheduled next wake-up, when scheduled. */
  nextTickAt: string | null
  lastDrivenAt: string | null
  attemptCount: number
  maxAttempts: number
  costTaka: number
}

export interface PlanDrivePanelData {
  /** Master kill-switch echo — UI shows "চালু/বন্ধ". */
  enabled: boolean
  drives: PlanDriveView[]
  activeCount: number
  needsDecisionCount: number
  /** Whole-taka spent vs the daily cap, for the panel header. */
  dailyCapTaka: number
  perPlanCapTaka: number
}

function phaseOf(state: AutodriveState): PlanDrivePhase {
  switch (state) {
    case 'blocked':
      return 'waiting-approval'
    case 'escalated':
      return 'needs-decision'
    case 'done':
      return 'done'
    default:
      return 'driving'
  }
}

function stepDetail(step: PlanStep): string | undefined {
  if (step.error) return step.error
  if (step.result == null) return undefined
  if (typeof step.result === 'string') return step.result
  try {
    return JSON.stringify(step.result).slice(0, 200)
  } catch {
    return String(step.result).slice(0, 200)
  }
}

/** The single "what's happening now" line the owner reads at a glance. */
function currentLine(plan: Plan, phase: PlanDrivePhase): string {
  if (phase === 'needs-decision') {
    return plan.selfCheckNote ?? 'আপনার সিদ্ধান্তের অপেক্ষায়।'
  }
  if (phase === 'waiting-approval') {
    return plan.selfCheckNote ?? 'আপনার অনুমোদনের অপেক্ষায়।'
  }
  const running = plan.steps.find((s) => s.status === 'running')
  if (running) return `চলছে: ${running.action}`
  const next = plan.steps.find((s) => s.status === 'pending')
  if (next) return `পরের ধাপ: ${next.action}`
  if (plan.steps.every((s) => s.status === 'done')) return 'সব ধাপ শেষ — যাচাই চলছে…'
  return 'কাজ চলছে…'
}

function toView(plan: Plan): PlanDriveView {
  const phase = phaseOf(plan.autodriveState)
  const steps: PlanDriveStepView[] = plan.steps.map((s) => ({
    id: s.id,
    action: s.action,
    status: s.status,
    toolName: s.toolName,
    detail: stepDetail(s),
  }))
  const doneCount = steps.filter((s) => s.status === 'done').length
  return {
    planId: plan.id,
    goal: plan.goal,
    conversationId: plan.conversationId ?? null,
    autodriveState: plan.autodriveState,
    phase,
    steps,
    doneCount,
    totalCount: steps.length,
    currentLine: currentLine(plan, phase),
    waitingReason:
      phase === 'needs-decision' || phase === 'waiting-approval'
        ? plan.selfCheckNote ?? undefined
        : undefined,
    nextTickAt: plan.nextTickAt ? new Date(plan.nextTickAt).toISOString() : null,
    lastDrivenAt: plan.lastDrivenAt ? new Date(plan.lastDrivenAt).toISOString() : null,
    attemptCount: plan.attemptCount,
    maxAttempts: plan.maxAttempts,
    costTaka: plan.costTaka,
  }
}

/**
 * Assemble the Plan-Drive panel for the owner. Read-only; safe to poll. Sorted so
 * the things needing the owner's attention float to the top.
 */
export async function getPlanDrivePanel(): Promise<PlanDrivePanelData> {
  const config = await getAutodriveConfig()
  const plans = await loadVisiblePlanDrives()
  const drives = plans.map(toView)

  // Order: needs-decision → waiting-approval → driving (most-recent within group).
  const rank: Record<PlanDrivePhase, number> = {
    'needs-decision': 0,
    'waiting-approval': 1,
    driving: 2,
    done: 3,
  }
  drives.sort((a, b) => rank[a.phase] - rank[b.phase])

  return {
    enabled: config.enabled,
    drives,
    activeCount: drives.filter((d) => d.phase === 'driving').length,
    needsDecisionCount: drives.filter((d) => d.phase === 'needs-decision').length,
    dailyCapTaka: config.dailyCapTaka,
    perPlanCapTaka: config.planCapTaka,
  }
}
