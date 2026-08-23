/**
 * Single-step executor — one head turn per plan step.
 *
 * The driver advances a plan ONE ready step at a time. Each step is executed by a
 * full source-bound head turn on the plan's drive conversation. The execution
 * request contains only the exact persisted step identity; the continuation
 * binder reconstructs its directive from AgentPlan/AgentPlanStep after a DB
 * claim, so engine prose never masquerades as an owner message.
 *
 * S0 — QUEUE MODE (the default whenever the worker queue is configured).
 * Running the step turn inside the tick used to create a timeout mismatch. The
 * source-bound continuation transport dispatches to `long-agent-task` when the
 * worker is healthy and otherwise executes the same claimed turn inline. Either
 * way, the driver reaps one durable terminal turn on a later tick.
 *
 * Approval handling: an autonomous turn cannot tap a confirm card. If the head
 * surfaces one (spend money, post, message staff), the executor STOPS and reports
 * `blocked` — the driver parks the plan and returns the step to 'pending', so
 * approving the card genuinely resumes it. Nothing irreversible happens unattended.
 */
import { prisma } from '@/lib/prisma'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import type { Plan, PlanStep } from '@/agent/lib/planner'
import { ensureDriveConversation } from '@/agent/lib/plan-driver/drive-conversation'
import { buildPlanStepContinuationBinding } from '@/agent/lib/continuation-binding'

export interface StepExecResult {
  /** The step ran cleanly (no error, no pending approval). */
  ok: boolean
  /** The head's short Bangla summary of what it did (becomes the step result). */
  summary: string
  /** Whole-USD model spend for this step's head turn. */
  costUsd: number
  /** True when an action needs owner approval — the plan must park as 'blocked'. */
  blocked: boolean
  /** Set when blocked: the pending action awaiting the owner. */
  pendingActionId?: string
  /** Set on a hard failure (model error / no conversation). */
  error?: string
  /** Queue mode: the step turn was handed to the worker; a later tick reaps it. */
  dispatched?: boolean
  /** Queue mode: the turn row to reap. */
  turnId?: string
}

/**
 * Owner messages typed into the plan's own thread that no step has consumed yet.
 * Marked consumed as they are handed over, so one instruction steers once.
 * Fail-open: a bookkeeping problem must never stop the step from running.
 */
async function claimDriveSteering(conversationId: string, stepId: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  try {
    const rows: Array<{ id: string; content: unknown; usage: unknown }> = await db.agentMessage.findMany({
      where: { conversationId, role: 'user' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, content: true, usage: true },
    })

    const ids: string[] = []
    for (const row of [...rows].reverse()) {
      const usage = (row.usage ?? {}) as Record<string, unknown>
      // Written by the engine itself, or already handed to an earlier step.
      if (usage.driverDirective === true) continue
      if (typeof usage.steeringConsumedBy === 'string') continue

      const blocks = Array.isArray(row.content) ? row.content as Array<Record<string, unknown>> : []
      const text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => String(b.text))
        .join('\n')
        .trim()
      if (!text) continue
      try {
        await db.agentMessage.update({
          where: { id: row.id },
          data: { usage: { ...usage, steeringConsumedBy: stepId } },
        })
        ids.push(row.id)
      } catch { /* an unclaimed row must never enter execution authority */ }
    }
    return ids
  } catch {
    return []
  }
}

/**
 * Execute one ready step of a plan. Never throws — all failures come back as
 * `{ ok:false, error }`.
 *
 * Returns `{ dispatched: true, turnId }` in queue mode: the step is now running
 * on the worker and reap.ts resolves it on a later tick.
 */
export async function executeStep(
  plan: Pick<Plan, 'id' | 'goal' | 'conversationId' | 'businessId'> & { conversationId?: string | null },
  step: PlanStep,
  opts: {
    businessId: AgentBusinessId
    driverModelId: string
    forceInline?: boolean
    /** Compatibility only: server binding rebuilds proposal mode from persisted grind state. */
    directiveSuffix?: string
  },
): Promise<StepExecResult> {
  let conversationId: string
  try {
    conversationId = await ensureDriveConversation(plan)
  } catch (err) {
    return {
      ok: false,
      summary: '',
      costUsd: 0,
      blocked: false,
      error: `could not open a drive conversation: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // G8 (owner ruling 2026-07-26) — Boss must be able to correct work WHILE it
  // runs, the way he corrects me mid-turn, without killing what is in flight.
  // Chat turns already claim steering messages each round; a Plan-Drive step
  // could not hear him at all. Anything he typed into this plan's thread since
  // the last step now rides at the TOP of the next step's directive.
  const steeringMessageIds = await claimDriveSteering(conversationId, step.id)
  let binding: Awaited<ReturnType<typeof buildPlanStepContinuationBinding>>
  try {
    binding = await buildPlanStepContinuationBinding({
      stepId: step.id,
      conversationId,
      ...(steeringMessageIds.length > 0 ? { steeringMessageIds } : {}),
    })
  } catch (err) {
    return {
      ok: false,
      summary: '',
      costUsd: 0,
      blocked: false,
      dispatched: false,
      error: `source-bound plan dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Queue and inline use the same immutable source binding. The binder links
  // AgentPlanStep.turnId atomically; the worker/inline executor later claims it
  // exactly once and renders all directive prose from persisted plan rows.
  try {
    const { enqueueAgentContinuation } = await import('@/agent/lib/approval-continuation')
    const enqueued = await enqueueAgentContinuation({
      conversationId,
      binding,
      force: true,
      ...(opts.forceInline ? { forceInline: true } : {}),
    })
    if (!['queued', 'completed', 'observe', 'deferred'].includes(enqueued.outcome) || !enqueued.turnId) {
      return {
        ok: false,
        summary: '',
        costUsd: 0,
        blocked: false,
        dispatched: false,
        error: `source-bound plan dispatch failed: ${enqueued.status || enqueued.outcome}`,
      }
    }
    // Inline completion is reaped through the same durable turn path on the
    // next driver tick; this keeps one settlement contract for both transports.
    return {
      ok: false,
      summary: '',
      costUsd: 0,
      blocked: false,
      dispatched: true,
      turnId: enqueued.turnId,
    }
  } catch (err) {
    return {
      ok: false,
      summary: '',
      costUsd: 0,
      blocked: false,
      dispatched: false,
      error: `source-bound plan dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
