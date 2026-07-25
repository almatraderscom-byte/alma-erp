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
import { prisma } from '@/lib/prisma'

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
  /**
   * G1 (owner ruling 2026-07-26) — the screen must never call a parked plan
   * "Running". His iOS panel said "Running 2" while both plans had been sitting
   * at nextTickAt=null for an hour. These three fields are the honest answer, so
   * no client has to infer state from the array length.
   */
  /** True ONLY while a step is actually executing or a tick is scheduled. */
  isRunning: boolean
  /** Owner-readable state, ready to print: "চলছে" / "আপনার সিদ্ধান্ত দরকার" / … */
  statusLabel: string
  /** The step running right now, when one is. */
  runningStep: string | null
  /** ms since this plan last did anything — "কতক্ষণ ধরে চুপ". */
  idleMs: number | null
  /**
   * Present only for a grind campaign ("fix all 246 issues"). Additive — every
   * existing web/native consumer keeps working without knowing about it.
   */
  grind?: GrindDriveView
}

/** Measured campaign progress. Every number here is counted, never claimed. */
export interface GrindDriveView {
  campaignId: string
  target: string
  /** "২৪৬ টার মধ্যে ১৮৩ টা ঠিক হয়েছে · ০ নতুন সমস্যা" */
  headline: string
  total: number
  fixed: number
  open: number
  claimedOnly: number
  regressed: number
  introduced: number
  /** What is standing between the campaign and "done" — empty means done. */
  blockers: string[]
  families: Array<{ family: string; total: number; fixed: number; open: number; mode: 'proposal' | 'apply' }>
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

/**
 * G4 (owner ruling 2026-07-26) — queued worker work must be VISIBLE as work.
 *
 * A crawl/audit/long task lives in agent_pending_actions while the worker runs
 * it. Nothing on screen said so, so an 8-minute crawl looked like the agent had
 * gone quiet. One row per job, with how long it has been running.
 */
export interface LiveJobView {
  actionId: string
  /** 'seo_audit' | 'long_agent_task' | … */
  type: string
  /** Owner-facing one-liner ("SEO audit: almatraders.com"). */
  summary: string
  startedAt: string
  runningMs: number
  conversationId: string | null
}

export interface PlanDrivePanelData {
  /** Master kill-switch echo — UI shows "চালু/বন্ধ". */
  enabled: boolean
  drives: PlanDriveView[]
  /** G1: genuinely-moving plans. A client showing "Running N" must use THIS. */
  runningCount: number
  /** Parked, waiting on an owner approval card. */
  waitingApprovalCount: number
  /** Recent terminal plans; additive so existing web/native consumers stay safe. */
  finished: PlanDriveHistoryView[]
  activeCount: number
  needsDecisionCount: number
  /** G4: worker jobs running RIGHT NOW — the live chip reads this. */
  runningJobs: LiveJobView[]
  /** Whole-taka spent vs the daily cap, for the panel header. */
  dailyCapTaka: number
  perPlanCapTaka: number
}

/** Job types whose run is long enough that silence looks like a hang. */
const LIVE_JOB_TYPES = ['seo_audit', 'long_agent_task', 'workbench_run', 'browser_action', 'agent_graph_run'] as const
/** Older than this and it is a stuck row, not live work — don't claim it is running. */
const LIVE_JOB_MAX_AGE_MS = 60 * 60_000

export async function loadRunningJobs(now = new Date()): Promise<LiveJobView[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const rows = await db.agentPendingAction.findMany({
      where: {
        type: { in: [...LIVE_JOB_TYPES] },
        status: 'approved', // approved = handed to the worker, not yet executed
        createdAt: { gte: new Date(now.getTime() - LIVE_JOB_MAX_AGE_MS) },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, type: true, summary: true, createdAt: true, conversationId: true },
    })
    return rows.map((r: { id: string; type: string; summary: string; createdAt: Date; conversationId: string | null }) => ({
      actionId: r.id,
      type: r.type,
      summary: (r.summary ?? r.type).slice(0, 120),
      startedAt: new Date(r.createdAt).toISOString(),
      runningMs: now.getTime() - new Date(r.createdAt).getTime(),
      conversationId: r.conversationId ?? null,
    }))
  } catch (err) {
    console.warn('[plan-drive-view] running jobs failed open:', err instanceof Error ? err.message : err)
    return []
  }
}

/** Owner-readable state. Printed as-is by web and native. */
const STATUS_LABEL: Record<PlanDrivePhase, string> = {
  driving: 'চলছে',
  'waiting-approval': 'অনুমোদনের অপেক্ষায়',
  'needs-decision': 'আপনার সিদ্ধান্ত দরকার',
  done: 'শেষ',
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

async function toView(plan: Plan): Promise<PlanDriveView> {
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
    // A plan is RUNNING only if a step is executing right now, or the driver has
    // actually scheduled its next tick. 'escalated' with no next tick is parked —
    // the exact state that spent an hour labelled "Running".
    isRunning:
      phase === 'driving'
      && (plan.steps.some((s) => s.status === 'running') || Boolean(plan.nextTickAt)),
    statusLabel: STATUS_LABEL[phase],
    runningStep: plan.steps.find((s) => s.status === 'running')?.action ?? null,
    idleMs: plan.lastDrivenAt ? Date.now() - new Date(plan.lastDrivenAt).getTime() : null,
    grind: (await grindViewForPlan(plan.id)) ?? undefined,
  }
}

/**
 * The campaign block, when this plan is one. Read-only and fail-open: a panel
 * must never break because a campaign row is odd.
 */
async function grindViewForPlan(planId: string): Promise<GrindDriveView | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const set = await db.agentFindingSet.findFirst({
      where: { planId },
      select: { id: true, target: true },
    })
    if (!set) return null

    const { runGrindCompletionGate, grindHeadline } = await import('@/agent/lib/grind/completion')
    const { getFamilyMode } = await import('@/agent/lib/grind/family-approval')
    const verdict = await runGrindCompletionGate(set.id)
    const families = await Promise.all(
      verdict.tally.byFamily.map(async (f) => ({
        ...f,
        mode: await getFamilyMode(set.target, f.family),
      })),
    )
    return {
      campaignId: set.id,
      target: set.target,
      headline: grindHeadline(verdict.tally),
      total: verdict.tally.total,
      fixed: verdict.tally.fixed,
      open: verdict.tally.open,
      claimedOnly: verdict.tally.claimedOnly,
      regressed: verdict.tally.regressed,
      introduced: verdict.tally.introduced,
      blockers: verdict.blockers,
      families,
    }
  } catch (err) {
    console.warn('[plan-drive-view] grind view failed open:', err instanceof Error ? err.message : err)
    return null
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
  const [config, plans, finishedPlans, runningJobs] = await Promise.all([
    getAutodriveConfig(),
    loadVisiblePlanDrives(),
    loadFinishedPlanDrives({ limit: 20 }),
    loadRunningJobs(),
  ])
  const drives = await Promise.all(plans.map(toView))
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
    runningCount: drives.filter((d) => d.isRunning).length,
    waitingApprovalCount: drives.filter((d) => d.phase === 'waiting-approval').length,
    needsDecisionCount: drives.filter((d) => d.phase === 'needs-decision').length,
    runningJobs,
    dailyCapTaka: config.dailyCapTaka,
    perPlanCapTaka: config.planCapTaka,
  }
}
