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

/** Planning/control calls manage the checklist; they are not checklist work. */
export const PLAN_CONTROL_TOOLS = new Set(['make_plan', 'execute_plan', 'get_plan'])

export type AdvanceableStep = {
  id: string
  action: string
  toolName?: string | null
  status: string
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
  /summari[sz]e|summary|cross[-\s]?check|self[-\s]?check|verify|validation|review|deliver|report|উত্তর|সারাংশ|যাচাই|মিলিয়ে|রিভিউ|ফলাফল/i

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
