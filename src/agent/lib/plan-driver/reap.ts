/**
 * Reap phase — resolve plan steps whose turn was DISPATCHED to the worker queue.
 *
 * Queue mode (executor.ts) hands the step turn to the `long-agent-task` queue and
 * returns immediately, so the tick never carries a 110s turn inside a 120s
 * function. The verdict lands here on a later tick:
 *
 *   turn done   → the step's result is the turn's final assistant message
 *                 (its cost comes from that same row), unless an approval card is
 *                 now waiting — then the step goes back to 'pending' and the plan
 *                 parks as 'blocked', so approving it genuinely resumes the step.
 *   turn error  → the step failed; markStepFailed counts the attempt and
 *                 schedules the retry window.
 *   still running → nothing to do; the driver leaves the plan parked.
 *   ghost       → dispatched long ago and never finalized (worker died): treated
 *                 as a failure so the step retries instead of hanging forever.
 */
import { prisma } from '@/lib/prisma'
import {
  type Plan,
  type PlanStep,
  getDispatchedSteps,
  markStepDone,
  markStepFailed,
  markStepBlocked,
} from '@/agent/lib/planner'
import { messageContentText } from '@/agent/lib/job-delivery'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** A dispatched turn still 'running' after this long is presumed dead. */
export const DISPATCH_GHOST_MS = 30 * 60 * 1000

export type ReapOutcome = 'done' | 'failed' | 'blocked' | 'waiting'

export interface ReapResult {
  stepId: string
  outcome: ReapOutcome
  detail: string
  /** Model spend of the reaped turn, in USD (0 when unknown). */
  costUsd: number
}

/** Is an owner approval card waiting on this conversation right now? */
async function hasOpenApproval(conversationId: string | null | undefined): Promise<boolean> {
  if (!conversationId) return false
  const [actions, asks] = await Promise.all([
    db.agentPendingAction.count({ where: { conversationId, status: 'pending' } }),
    db.agentAskCard.count({ where: { conversationId, status: 'pending' } }).catch(() => 0),
  ])
  return actions + asks > 0
}

/**
 * Resolve every dispatched step of one plan. Never throws — a bookkeeping error
 * leaves the step dispatched and the next tick tries again.
 */
export async function reapPlan(plan: Plan, now = new Date()): Promise<ReapResult[]> {
  const out: ReapResult[] = []
  for (const step of getDispatchedSteps(plan)) {
    try {
      out.push(await reapStep(plan, step, now))
    } catch (err) {
      console.warn(
        `[plan-driver] reap failed for step ${step.id}:`,
        err instanceof Error ? err.message : err,
      )
      out.push({ stepId: step.id, outcome: 'waiting', detail: 'reap error', costUsd: 0 })
    }
  }
  return out
}

async function reapStep(plan: Plan, step: PlanStep, now: Date): Promise<ReapResult> {
  const turn = await db.agentTurn.findUnique({
    where: { id: step.turnId },
    select: { status: true, assistantMessageId: true, conversationId: true, startedAt: true },
  })

  if (!turn) {
    await markStepFailed(step.id, 'dispatched turn row disappeared', now)
    return { stepId: step.id, outcome: 'failed', detail: 'turn missing', costUsd: 0 }
  }

  if (turn.status === 'running') {
    const ageMs = now.getTime() - new Date(step.dispatchedAt ?? turn.startedAt ?? now).getTime()
    if (ageMs < DISPATCH_GHOST_MS) {
      return { stepId: step.id, outcome: 'waiting', detail: 'worker still running', costUsd: 0 }
    }
    await db.agentTurn
      .updateMany({ where: { id: step.turnId, status: 'running' }, data: { status: 'error', finishedAt: now } })
      .catch(() => {})
    await markStepFailed(step.id, 'worker turn never finished (ghost)', now)
    return { stepId: step.id, outcome: 'failed', detail: 'ghost turn', costUsd: 0 }
  }

  // Terminal turn — read what it produced.
  const message = turn.assistantMessageId
    ? await db.agentMessage.findUnique({
        where: { id: turn.assistantMessageId },
        select: { content: true, costUsd: true },
      })
    : await db.agentMessage.findFirst({
        where: { conversationId: turn.conversationId, role: 'assistant', createdAt: { gte: step.dispatchedAt ?? undefined } },
        orderBy: { createdAt: 'desc' },
        select: { content: true, costUsd: true },
      })

  const summary = message ? messageContentText(message.content).slice(0, 4000) : ''
  const costUsd = message?.costUsd != null ? Number(message.costUsd) : 0

  // An approval card raised during the turn outranks its text: the work is NOT
  // done, it is waiting for Boss. Back to 'pending' so approving it resumes the
  // step (leaving it 'running' is what used to deadlock the plan).
  if (await hasOpenApproval(turn.conversationId ?? plan.conversationId)) {
    await markStepBlocked(step.id)
    return { stepId: step.id, outcome: 'blocked', detail: step.action, costUsd }
  }

  if (turn.status === 'done') {
    await markStepDone(step.id, summary || 'ধাপ সম্পন্ন হয়েছে।')
    return { stepId: step.id, outcome: 'done', detail: step.action, costUsd }
  }

  await markStepFailed(step.id, summary ? `turn ${turn.status}: ${summary.slice(0, 300)}` : `turn ${turn.status}`, now)
  return { stepId: step.id, outcome: 'failed', detail: `turn ${turn.status}`, costUsd }
}
