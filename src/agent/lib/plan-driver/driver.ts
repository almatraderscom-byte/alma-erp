/**
 * Plan-Driver orchestration — the per-plan decision engine behind the autonomous
 * "pursue-until-completion" loop. The tick route loads the drivable plans + the
 * day's spend, then hands each plan here for ONE bounded advance.
 *
 * Per plan, in strict safety order:
 *   1. plan cost cap        → escalate (blocked), owner must decide.
 *   2. max consecutive stalls → escalate (blocked).
 *   3. currently 'blocked'  → re-check the owner approval; resume only when cleared.
 *   4. all steps done       → completion gate; DONE only if the gate agrees.
 *   5. a ready step         → execute ONE step (Qwen head turn).
 *   6. no ready step         → stuck on a failed/incomplete dep → escalate.
 *
 * Everything mutating funnels through the planner helpers; every paid action
 * (executor turn + completion gate) adds its whole-taka spend to the plan and the
 * daily ledger. Caps are checked BEFORE any paid work, so the driver can never
 * overspend by more than one in-flight step.
 *
 * Daily-cap enforcement lives in the caller (tick route): when the day's spend is
 * already at/over the cap, it does not call into the driver at all.
 */
import { prisma } from '@/lib/prisma'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import { normalizeBusinessId } from '@/lib/agent-api/business-context'
import {
  type Plan,
  getReadySteps,
  selfCheck,
  markStepRunning,
  markStepDone,
  markStepFailed,
  updatePlanStatus,
  setAutodriveState,
  recordDriveTick,
  countRepairSteps,
  appendCorrectiveStep,
} from '@/agent/lib/planner'
import { type AutodriveConfig, usdToTaka, getPlanCapOverrideTaka } from '@/agent/lib/autodrive-config'
import { executeStep } from '@/agent/lib/plan-driver/executor'
import { runCompletionGate } from '@/agent/lib/plan-driver/completion-gate'
import { completeSourceTodoForPlan } from '@/agent/lib/plan-driver/promote'
import { notifyOwnerIfAway } from '@/agent/lib/notify-owner'

export type DriveOutcome =
  | 'step-done'
  | 'step-failed'
  | 'blocked-approval'
  | 'waiting-approval'
  | 'plan-done'
  | 'escalated-cap'
  | 'escalated-attempts'
  | 'escalated-stuck'
  | 'escalated-gate'
  | 'repair-queued'
  | 'no-op'

/**
 * Phase C auto-repair ceiling: how many corrective steps the driver may append to a
 * single plan before it gives up and escalates. Bounds the repair loop independently
 * of maxAttempts (a successful corrective step resets the stall counter, so without
 * this cap a plan that keeps half-fixing itself could loop indefinitely under the
 * cost cap). Small on purpose — two self-corrections, then a human looks.
 */
const MAX_AUTOREPAIR_STEPS = 2

export interface DriveResult {
  planId: string
  goal: string
  outcome: DriveOutcome
  detail: string
  /** Whole-taka spent advancing this plan this tick (head turn + gate). */
  costTaka: number
}

/**
 * Self-scheduled wake-up — the driver decides WHEN to come back to a plan based on
 * what just happened, the way Claude paces its own follow-ups:
 *   - 'progress'  → real movement; come back soon to keep the momentum.
 *   - 'retry'     → a step failed / approval pending; wait a few cycles before retry.
 * Escalations don't schedule a tick at all (they wait on the owner, see escalate()).
 */
function backoffNextTick(
  config: AutodriveConfig,
  now: Date,
  kind: 'progress' | 'retry' = 'progress',
): Date {
  const baseMs = config.backoffMin * 60 * 1000
  const factor = kind === 'retry' ? 4 : 1 // back off harder after a stall
  return new Date(now.getTime() + baseMs * factor)
}

/**
 * Is the plan's conversation still waiting on an owner approval? A 'blocked' plan
 * resumes only when no pending action remains for its conversation.
 */
async function hasOpenApproval(conversationId: string | null | undefined): Promise<boolean> {
  if (!conversationId) return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const open = await db.agentPendingAction.count({
    where: { conversationId, status: 'pending' },
  })
  return open > 0
}

/**
 * Escalate to the owner: park in the dedicated 'escalated' state and push if he is
 * away. Unlike 'blocked' (approval, auto-resumes), 'escalated' is NOT re-picked by
 * the tick — so a capped/stuck plan can't re-hit the same wall every backoff and
 * spam the owner. It stays visible in the Plan-Drive panel until the owner acts.
 * nextTickAt is cleared for honesty: nothing auto-fires until a decision is made.
 */
async function escalate(
  plan: Plan,
  outcome: Extract<DriveOutcome, `escalated-${string}`>,
  reason: string,
): Promise<DriveResult> {
  await setAutodriveState(plan.id, 'escalated', {
    nextTickAt: null,
    selfCheckNote: reason,
  })
  // P0 terminal-state contract: an escalated plan leaves a self-contained
  // checkpoint so the owner's next reply resumes from the exact stuck step.
  try {
    const { writeCheckpoint } = await import('@/agent/lib/checkpoint')
    const done = plan.steps.filter((s) => s.status === 'done').map((s) => s.action)
    const stuck = plan.steps.find((s) => s.status === 'failed' || s.status === 'running')
      ?? plan.steps.find((s) => s.status === 'pending')
    await writeCheckpoint({
      taskRef: `plan:${plan.id}`,
      taskType: 'plan',
      state: 'waiting_for_owner',
      goal: plan.goal,
      summaryBn: `"${plan.goal}" plan-টা থেমে গেছে — ${reason}`,
      doneSteps: done,
      currentStep: stuck?.action ?? 'unknown step',
      artifacts: [],
      error: reason,
      question: 'কাজটা কি চালিয়ে যাবো, নাকি অন্যভাবে করবো?',
      nextActions: ['Boss-এর সিদ্ধান্ত নাও, তারপর plan-টা ঠিক এই step থেকে resume করো'],
      resumeHint: `Plan ${plan.id} escalated (${outcome}): ${reason}. Done: ${done.length}/${plan.steps.length} steps. Resume at step "${stuck?.action ?? '?'}".`,
      conversationId: plan.conversationId ?? null,
    })
  } catch (cpErr) {
    console.error('[plan-driver] checkpoint write failed:', cpErr)
  }
  void notifyOwnerIfAway({
    tier: 2,
    title: 'Plan-Driver — সিদ্ধান্ত দরকার',
    message: `"${plan.goal}" — ${reason}`,
    category: 'task',
  }).catch(() => {})
  return { planId: plan.id, goal: plan.goal, outcome, detail: reason, costTaka: 0 }
}

/**
 * Advance ONE plan by at most one step. Never throws — any unexpected error parks
 * the plan with a backoff and reports a no-op, so one bad plan can't break the tick.
 */
export async function drivePlan(plan: Plan, config: AutodriveConfig): Promise<DriveResult> {
  const now = new Date()
  const businessId: AgentBusinessId = normalizeBusinessId(plan.businessId ?? undefined)

  try {
    // 1. Per-plan cost cap — a hard stop that needs the owner to lift. The owner can
    //    grant THIS plan extra budget from the Live Desk (per-plan KV override),
    //    which takes precedence over the global cap.
    const capOverride = await getPlanCapOverrideTaka(plan.id)
    const effectiveCap = Math.max(config.planCapTaka, capOverride)
    if (effectiveCap > 0 && plan.costTaka >= effectiveCap) {
      return await escalate(
        plan,
        'escalated-cap',
        `প্ল্যানের খরচ সীমা ছুঁয়েছে (${plan.costTaka}/${effectiveCap} টাকা)। এগোতে অনুমতি দিন।`,
      )
    }

    // 2. Too many consecutive stalls — watchdog escalation.
    if (plan.attemptCount >= plan.maxAttempts) {
      return await escalate(
        plan,
        'escalated-attempts',
        `${plan.maxAttempts} বার চেষ্টা করেও আটকে আছে। হাতে নিয়ে দেখুন কী দরকার।`,
      )
    }

    // 3. Blocked plan — resume only when the owner approval cleared.
    if (plan.autodriveState === 'blocked') {
      if (await hasOpenApproval(plan.conversationId)) {
        await recordDriveTick(plan.id, { nextTickAt: backoffNextTick(config, now), attempt: 'keep', now })
        return {
          planId: plan.id, goal: plan.goal, outcome: 'waiting-approval',
          detail: 'অনুমোদনের অপেক্ষায়', costTaka: 0,
        }
      }
      // Approval resolved (or none was pending) → resume driving.
      await setAutodriveState(plan.id, 'driving', { nextTickAt: now })
    }

    // 4. Every step done → completion gate decides true DONE.
    const check = selfCheck(plan)
    if (check.allDone) {
      const verdict = await runCompletionGate(plan, config.gateModel, { conversationId: plan.conversationId })
      const gateTaka = usdToTaka(verdict.costUsd)
      if (verdict.done) {
        await updatePlanStatus(plan.id, 'done', verdict.reason)
        await setAutodriveState(plan.id, 'done', { selfCheckNote: verdict.reason })
        await recordDriveTick(plan.id, { addCostTaka: gateTaka, attempt: 'reset', now })
        // If this plan was born from a stuck daily todo, close that todo too.
        await completeSourceTodoForPlan(plan.id).catch(() => {})
        void notifyOwnerIfAway({
          tier: 1,
          title: 'Plan-Driver — সম্পন্ন ✅',
          message: `"${plan.goal}" শেষ হয়েছে। ${verdict.reason}`,
          category: 'report',
        }).catch(() => {})
        return { planId: plan.id, goal: plan.goal, outcome: 'plan-done', detail: verdict.reason, costTaka: gateTaka }
      }
      // Steps ran but the goal is not truly met. Two paths:
      //  - auto-repair ON and under the repair ceiling → append ONE corrective step
      //    (the gate's reason becomes the new step's action) and keep driving. The
      //    frozen 'done' steps would re-fail the gate forever, so we must add NEW
      //    work for the next tick to act on, not just re-run the gate.
      //  - otherwise → escalate to the owner, as before.
      if (config.autoRepair && countRepairSteps(plan) < MAX_AUTOREPAIR_STEPS) {
        await appendCorrectiveStep(plan.id, `সংশোধন: ${verdict.reason}`)
        await setAutodriveState(plan.id, 'driving', { nextTickAt: backoffNextTick(config, now, 'retry') })
        await recordDriveTick(plan.id, { addCostTaka: gateTaka, attempt: 'increment', now })
        return { planId: plan.id, goal: plan.goal, outcome: 'repair-queued', detail: verdict.reason, costTaka: gateTaka }
      }
      await recordDriveTick(plan.id, { addCostTaka: gateTaka, attempt: 'increment', now })
      return await escalate(plan, 'escalated-gate', `যাচাই: ${verdict.reason}`)
    }

    // 5. Pick the next ready step and execute exactly one.
    const ready = getReadySteps(plan)
    if (ready.length === 0) {
      // Nothing ready and not all done → a dependency failed or is stuck.
      const failedNote = check.failedSteps.length > 0
        ? `আটকে আছে — ব্যর্থ ধাপ: ${check.failedSteps.join(', ')}`
        : 'কোনো ধাপ এগোনোর মতো প্রস্তুত নেই (নির্ভরতা অসম্পূর্ণ)।'
      return await escalate(plan, 'escalated-stuck', failedNote)
    }

    const step = ready[0]
    await markStepRunning(step.id)
    const res = await executeStep(plan, step, { businessId, driverModelId: config.driverModel })
    const stepTaka = usdToTaka(res.costUsd)

    // 5a. Needs owner approval → park as blocked; leave the step running so it
    //     resumes from the same point once the owner acts on the card.
    if (res.blocked) {
      await setAutodriveState(plan.id, 'blocked', {
        nextTickAt: backoffNextTick(config, now, 'retry'),
        selfCheckNote: `অনুমোদনের অপেক্ষায়: ${step.action}`,
      })
      await recordDriveTick(plan.id, { addCostTaka: stepTaka, attempt: 'increment', now })
      void notifyOwnerIfAway({
        tier: 2,
        title: 'Plan-Driver — অনুমোদন দরকার',
        message: `"${plan.goal}" — "${step.action}" এর জন্য আপনার অনুমোদন দরকার।`,
        category: 'task',
      }).catch(() => {})
      return { planId: plan.id, goal: plan.goal, outcome: 'blocked-approval', detail: step.action, costTaka: stepTaka }
    }

    // 5b. Hard failure → mark the step failed; count a stall. Next ready tick
    //     retries from here until maxAttempts consecutive stalls escalate.
    if (res.error) {
      await markStepFailed(step.id, res.error)
      await recordDriveTick(plan.id, { addCostTaka: stepTaka, nextTickAt: backoffNextTick(config, now, 'retry'), attempt: 'increment', now })
      return { planId: plan.id, goal: plan.goal, outcome: 'step-failed', detail: res.error, costTaka: stepTaka }
    }

    // 5c. Progress → mark the step done, reset the stall counter, keep driving.
    await markStepDone(step.id, res.summary)
    await setAutodriveState(plan.id, 'driving', { nextTickAt: backoffNextTick(config, now) })
    await recordDriveTick(plan.id, { addCostTaka: stepTaka, attempt: 'reset', now })
    return { planId: plan.id, goal: plan.goal, outcome: 'step-done', detail: step.action, costTaka: stepTaka }
  } catch (err) {
    // Defensive: never let one plan break the whole tick. Park with a short backoff.
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[plan-driver] drivePlan ${plan.id} failed:`, msg)
    try {
      await recordDriveTick(plan.id, { nextTickAt: backoffNextTick(config, now, 'retry'), attempt: 'increment', now })
    } catch { /* swallow */ }
    return { planId: plan.id, goal: plan.goal, outcome: 'no-op', detail: `error: ${msg}`, costTaka: 0 }
  }
}
