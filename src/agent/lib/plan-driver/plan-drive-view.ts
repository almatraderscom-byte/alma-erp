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
  loadFinishedPlanDrives,
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
  /** Stable origin for honest live elapsed time (never reset by polling). */
  startedAt: string | null
  lastDrivenAt: string | null
  attemptCount: number
  maxAttempts: number
  costTaka: number
}

export type PlanDriveHistoryStatus = 'completed' | 'failed' | 'stopped'

export interface PlanDriveHistoryView {
  planId: string
  goal: string
  conversationId: string | null
  status: PlanDriveHistoryStatus
  /** The original owner/agent task brief. */
  input: string
  /** Verified step output, when the plan produced one. */
  result?: string
  /** Failure/stop reason, kept distinct from successful output. */
  error?: string
  startedAt: string | null
  completedAt: string | null
  steps: PlanDriveStepView[]
  costTaka: number
}

export interface PlanDrivePanelData {
  /** Master kill-switch echo — UI shows "চালু/বন্ধ". */
  enabled: boolean
  drives: PlanDriveView[]
  /** Recent terminal plans; additive so existing web/native consumers stay safe. */
  finished: PlanDriveHistoryView[]
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
    return JSON.stringify(step.result).slice(0, 4000)
  } catch {
    return String(step.result).slice(0, 4000)
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
    startedAt: plan.createdAt ? new Date(plan.createdAt).toISOString() : null,
    lastDrivenAt: plan.lastDrivenAt ? new Date(plan.lastDrivenAt).toISOString() : null,
    attemptCount: plan.attemptCount,
    maxAttempts: plan.maxAttempts,
    costTaka: plan.costTaka,
  }
}

function historyStatus(plan: Plan): PlanDriveHistoryStatus {
  if (plan.autodriveState === 'abandoned') return 'stopped'
  if (plan.autodriveState === 'failed' || plan.status === 'failed') return 'failed'
  return 'completed'
}

function historyResult(plan: Plan): string | undefined {
  const lines = plan.steps.flatMap((step) => {
    if (step.status !== 'done') return []
    const detail = stepDetail(step)
    return detail ? [`${step.action}: ${detail}`] : []
  })
  if (lines.length > 0) return lines.join('\n')
  if (historyStatus(plan) === 'completed') {
    return plan.selfCheckNote ?? 'সব ধাপ যাচাই করে কাজটি সম্পন্ন হয়েছে।'
  }
  return undefined
}

function historyError(plan: Plan): string | undefined {
  const failed = plan.steps.find((step) => step.status === 'failed')
  if (failed?.error) return failed.error
  if (historyStatus(plan) === 'stopped') return plan.selfCheckNote ?? 'Owner task-টি বন্ধ করেছেন।'
  if (historyStatus(plan) === 'failed') return plan.selfCheckNote ?? 'কাজটি সম্পন্ন করা যায়নি।'
  return undefined
}

function toHistoryView(plan: Plan): PlanDriveHistoryView {
  return {
    planId: plan.id,
    goal: plan.goal,
    conversationId: plan.conversationId ?? null,
    status: historyStatus(plan),
    input: plan.goal,
    result: historyResult(plan),
    error: historyError(plan),
    startedAt: plan.createdAt ? new Date(plan.createdAt).toISOString() : null,
    completedAt: plan.completedAt
      ? new Date(plan.completedAt).toISOString()
      : plan.updatedAt
        ? new Date(plan.updatedAt).toISOString()
        : null,
    steps: plan.steps.map((step) => ({
      id: step.id,
      action: step.action,
      status: step.status,
      toolName: step.toolName,
      detail: stepDetail(step),
    })),
    costTaka: plan.costTaka,
  }
}

/**
 * Assemble the Plan-Drive panel for the owner. Read-only; safe to poll. Sorted so
 * the things needing the owner's attention float to the top.
 */
export async function getPlanDrivePanel(): Promise<PlanDrivePanelData> {
  const [config, plans, finishedPlans] = await Promise.all([
    getAutodriveConfig(),
    loadVisiblePlanDrives(),
    loadFinishedPlanDrives({ limit: 20 }),
  ])
  const drives = plans.map(toView)
  const finished = finishedPlans.map(toHistoryView)

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
    finished,
    activeCount: drives.filter((d) => d.phase === 'driving').length,
    needsDecisionCount: drives.filter((d) => d.phase === 'needs-decision').length,
    dailyCapTaka: config.dailyCapTaka,
    perPlanCapTaka: config.planCapTaka,
  }
}
