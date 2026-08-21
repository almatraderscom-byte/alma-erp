/**
 * Tick a plan's steps off as the turn actually does them.
 *
 * Owner ask 2026-08-18: lay the whole plan out first, then mark each part done as
 * it finishes, with the running part spinning in the dock chip — the way Claude
 * Code works through a task list.
 *
 * The first half already worked: `make_plan` writes the steps and the tracker
 * shows them. The second half did not. `markStepDone` was called from exactly one
 * place — the autonomous plan-driver, which ticks from the VPS worker every two
 * minutes and advances one step per tick, each its own model turn. So a plan made
 * during a chat turn sat entirely `pending` while that same turn did the work in
 * front of the owner, and the checklist never moved.
 *
 * This closes it: the turn that runs a tool marks the step that tool belongs to.
 * Autodrive keeps its job — genuinely long pursuits — and is untouched.
 *
 * Deliberately conservative about *which* step: a step that names a different
 * tool is never ticked by this, because a checklist that marks the wrong line
 * done is worse than one that does not move.
 */
import { markStepDone, markStepFailed, markStepRunning } from '@/agent/lib/planner'
import type { WorkStepsBlocker } from '@/agent/lib/work-steps'

/** Planning/control calls manage the checklist; they are not checklist work. */
export const PLAN_CONTROL_TOOLS = new Set(['make_plan', 'execute_plan', 'get_plan'])

/** Create the prospective tracker before sibling calls can perform its work. */
export function prioritizePlanCreationForUntrackedRound<T extends { name: string }>(
  calls: T[],
  hasTracker: boolean,
): T[] {
  if (hasTracker || !calls.some((call) => call.name === 'make_plan')) return calls
  return [
    ...calls.filter((call) => call.name === 'make_plan'),
    ...calls.filter((call) => call.name !== 'make_plan'),
  ]
}

export type AdvanceableStep = {
  id: string
  action: string
  toolName?: string | null
  status: string
}

export type PendingActionTrackerState = 'approval' | 'worker' | 'complete' | 'failed' | null

/** Durable pending-action status translated into truthful tracker lifecycle. */
export function pendingActionTrackerState(status: string | null | undefined): PendingActionTrackerState {
  if (status === 'pending') return 'approval'
  if (status === 'approved') return 'worker'
  if (status === 'executed') return 'complete'
  if (status && ['failed', 'rejected', 'expired', 'cancelled', 'superseded'].includes(status)) return 'failed'
  return null
}

/**
 * A successful tool result can still mean "the owner must decide" rather than
 * "the requested action happened". Keep that distinction pure and shared so a
 * staged card never becomes completion evidence for its plan row.
 */
export function ownerBlockerFromToolResult(result: {
  success: boolean
  data?: unknown
}, pendingActionStatus?: string | null): WorkStepsBlocker | null {
  if (!result.success || !result.data || typeof result.data !== 'object') return null
  const data = result.data as Record<string, unknown>
  if (typeof data.askCardId === 'string' && data.askCardId) {
    return { kind: 'question', refId: data.askCardId }
  }
  if (typeof data.pendingActionId === 'string' && data.pendingActionId) {
    // pendingActionId is also the job handle for already-approved background
    // work. When the caller supplied the durable row status it is authoritative:
    // only an actually pending action owns an approval card. The explicit flag
    // remains the safe fallback for pure callers that cannot read the row.
    const awaitingOwner = pendingActionStatus !== undefined
      ? pendingActionTrackerState(pendingActionStatus) === 'approval'
      : data.awaitingApproval === true
    return awaitingOwner ? { kind: 'approval', refId: data.pendingActionId } : null
  }
  return null
}

/**
 * The step a tool call belongs to, or null when nothing can be claimed honestly.
 *
 * Exact tool match wins wherever it sits in the list — a plan step that names
 * `get_orders` is that step, whatever ran before it. Otherwise the first open
 * step is claimed ONLY if it names no tool of its own; an unrelated named step
 * is left alone.
 */
export function pickStepForTool(
  steps: AdvanceableStep[],
  toolName: string,
): AdvanceableStep | null {
  if (PLAN_CONTROL_TOOLS.has(toolName)) return null
  const open = steps.filter((s) => s.status === 'pending' || s.status === 'running')
  if (!open.length) return null
  const named = open.find((s) => s.toolName === toolName)
  if (named) return named
  const first = open[0]
  return first.toolName ? null : first
}

const FINAL_DELIVERY_STEP_RE =
  /summari[sz]e|summary|deliver|report|উত্তর|সারাংশ|ফলাফল/i

/**
 * A persisted final answer is durable evidence for exactly one remaining
 * delivery/summary step. It is not evidence for skipped data collection, so we
 * claim only the final open, tool-free row after every earlier row is done.
 */
export function pickFinalDeliveryStep(
  steps: AdvanceableStep[],
): AdvanceableStep | null {
  const open = steps.filter((step) => step.status === 'pending' || step.status === 'running')
  if (open.length !== 1) return null
  const candidate = open[0]
  if (steps[steps.length - 1]?.id !== candidate.id || candidate.toolName) return null
  const prior = steps.slice(0, -1)
  if (prior.some((step) => step.status !== 'done' && step.status !== 'skipped')) return null
  return FINAL_DELIVERY_STEP_RE.test(candidate.action) ? candidate : null
}

export type PlanCompletionRow = { seq: number; action: string; status: string }

/**
 * Completion-gate projection for the narrow window before the assistant reply
 * is persisted. The model has already produced the final prose, but the durable
 * step writer intentionally waits for the message ID. Treat only the exact
 * final delivery row as satisfied in-memory so we do not schedule a needless
 * continuation; the canonical plan row is still written only after message
 * persistence succeeds.
 */
export function projectFinalDeliveryForCompletion(
  rows: PlanCompletionRow[],
  steps: AdvanceableStep[],
  hasFinalReply: boolean,
): { rows: PlanCompletionRow[]; projectedStepId: string | null } {
  if (!hasFinalReply) return { rows, projectedStepId: null }
  const step = pickFinalDeliveryStep(steps)
  if (!step || rows.length !== steps.length) return { rows, projectedStepId: null }
  const lastIndex = rows.length - 1
  if (rows[lastIndex]?.action !== step.action) return { rows, projectedStepId: null }
  return {
    rows: rows.map((row, index) => index === lastIndex ? { ...row, status: 'done' } : row),
    projectedStepId: step.id,
  }
}

/** A durably completed tracker outranks an earlier deadline continuation hint. */
export function continuationAfterTrackerSettlement(
  needContinue: boolean,
  trackerStatus: string | null | undefined,
): boolean {
  return needContinue && trackerStatus !== 'completed'
}

/**
 * The explicit tracker sync may deduplicate after markStepDone's background
 * refresh wins. Freshly loaded rows plus the awaited final write are still
 * durable completion evidence even when no new snapshot is returned.
 */
export function continuationAfterPlanRowsSettlement(
  needContinue: boolean,
  steps: AdvanceableStep[],
): boolean {
  const completed = steps.length > 0
    && steps.every((step) => step.status === 'done' || step.status === 'skipped')
  return needContinue && !completed
}

/** A projected final row cannot suppress recovery until its whole close commits. */
export function projectedDeliveryNeedsContinuation(
  projectedStepId: string | null,
  durablyClosed: boolean,
): boolean {
  return Boolean(projectedStepId) && !durablyClosed
}

/** Never reset the bounded hop budget for a merely projected completion. */
export function shouldClearContinuationHops(input: {
  taskUnfinished: boolean
  projectedStepId: string | null
  projectedDurablyClosed: boolean
}): boolean {
  if (input.taskUnfinished) return false
  return !input.projectedStepId || input.projectedDurablyClosed
}

/** A completed plan still needs recovery while its old checkpoint stays open. */
export function completionNeedsCheckpointRetry(input: {
  completionAction: string | null | undefined
  projectedStepId: string | null
  checkpointDurablyClosed: boolean
}): boolean {
  return input.completionAction === 'complete'
    && !input.projectedStepId
    && !input.checkpointDurablyClosed
}

/** A plan-bound hop cannot claim completion when its durable rows were unreadable. */
export function unevaluatedPlanNeedsContinuation(input: {
  planBoundTurn: boolean
  hasOwnerGate: boolean
  planProgressLoaded: boolean
}): boolean {
  return input.planBoundTurn && !input.hasOwnerGate && !input.planProgressLoaded
}

/**
 * Claim the step this tool is about to run and put it in `running`, so the chip
 * shows the part being worked on while it is being worked on. Called BEFORE the
 * tool executes; marking running and done in the same breath would mean the owner
 * never sees a step spinning, which is the thing he asked for.
 */
export async function beginPlanStepForTool(
  steps: AdvanceableStep[],
  toolName: string,
): Promise<string | null> {
  const step = pickStepForTool(steps, toolName)
  if (!step) return null
  try {
    if (step.status === 'pending') {
      await markStepRunning(step.id)
      step.status = 'running'
    }
    return step.id
  } catch {
    // The checklist is a view of the work, never a gate on it — a failure to
    // record progress must not take the turn down with it.
    return null
  }
}

/** Close the step claimed by `beginPlanStepForTool` with the tool's outcome. */
export async function finishPlanStep(input: {
  stepId: string
  ok: boolean
  error?: string | null
  resultSummary?: unknown
}): Promise<'done' | 'failed' | null> {
  try {
    if (input.ok) {
      await markStepDone(input.stepId, input.resultSummary ?? null)
      return 'done'
    }
    await markStepFailed(input.stepId, input.error ?? 'tool call failed')
    return 'failed'
  } catch {
    return null
  }
}
