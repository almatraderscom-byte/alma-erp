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
  markStepBlocked,
  markStepDispatched,
  getDispatchedSteps,
  hasExhaustedStep,
  loadPlan,
  updatePlanStatus,
  setAutodriveState,
  recordDriveTick,
  countRepairSteps,
  appendCorrectiveStep,
} from '@/agent/lib/planner'
import {
  type AutodriveConfig,
  usdToMilliTaka,
  milliTakaToTaka,
  getPlanCapOverrideTaka,
} from '@/agent/lib/autodrive-config'
import { executeStep } from '@/agent/lib/plan-driver/executor'
import { reapPlan } from '@/agent/lib/plan-driver/reap'
import {
  afterGrindStep,
  grindCompletionForPlan,
  preflightGrindStep,
} from '@/agent/lib/grind/driver-hooks'
import {
  deliverPlanOutcome,
  elapsedBn,
  isOverBudget,
  planBudgetMs,
} from '@/agent/lib/plan-driver/plan-delivery'
import { runCompletionGate } from '@/agent/lib/plan-driver/completion-gate'
import { completeSourceTodoForPlan } from '@/agent/lib/plan-driver/promote'
import { notifyOwnerIfAway } from '@/agent/lib/notify-owner'

export type DriveOutcome =
  | 'step-done'
  | 'step-failed'
  | 'step-dispatched'
  | 'waiting-dispatch'
  | 'waiting-retry'
  | 'blocked-approval'
  | 'waiting-approval'
  | 'plan-done'
  | 'escalated-cap'
  | 'escalated-attempts'
  | 'escalated-stuck'
  | 'escalated-gate'
  | 'repair-queued'
  | 'no-op'

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
 * Is this PLAN still waiting on the owner? A driven plan runs in its own drive
 * conversation (see drive-conversation.ts), so conversation-scoped IS
 * plan-scoped: another plan's card can no longer hold this one hostage, and this
 * plan's card can no longer be mistaken for cleared.
 *
 * Ask cards count too. An ask card ("which of these do you want?") blocks the
 * agent exactly like an approval card does — counting only approvals let a plan
 * resume and talk straight past a question Boss had not answered.
 */
async function hasOpenApproval(conversationId: string | null | undefined): Promise<boolean> {
  if (!conversationId) return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const [actions, asks] = await Promise.all([
    db.agentPendingAction.count({ where: { conversationId, status: 'pending' } }),
    db.agentAskCard.count({ where: { conversationId, status: 'pending' } }).catch(() => 0),
  ])
  return actions + asks > 0
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
  // G5 — the outcome goes to Boss's own chat, not only into a panel he has to
  // open. A push only fires when he is away; this always lands.
  await deliverPlanOutcome(plan, 'stopped', reason).catch(() => {})
  return { planId: plan.id, goal: plan.goal, outcome, detail: reason, costTaka: 0 }
}

/**
 * Advance ONE plan by at most one step. Never throws — any unexpected error parks
 * the plan with a backoff and reports a no-op, so one bad plan can't break the tick.
 */
export async function drivePlan(planIn: Plan, config: AutodriveConfig): Promise<DriveResult> {
  const now = new Date()
  let plan = planIn
  const businessId: AgentBusinessId = normalizeBusinessId(plan.businessId ?? undefined)

  try {
    // 0. REAP — resolve any step whose turn was dispatched to the worker queue on
    //    an earlier tick. This runs BEFORE the caps so a finished step is always
    //    booked (and its spend recorded) even on the tick that hits a limit.
    if (getDispatchedSteps(plan).length > 0) {
      const reaped = await reapPlan(plan, now)
      const reapedMilli = reaped.reduce((sum, r) => sum + usdToMilliTaka(r.costUsd), 0)
      const stillWaiting = reaped.filter((r) => r.outcome === 'waiting')
      const blocked = reaped.find((r) => r.outcome === 'blocked')

      if (blocked) {
        await setAutodriveState(plan.id, 'blocked', {
          nextTickAt: backoffNextTick(config, now, 'retry'),
          selfCheckNote: `অনুমোদনের অপেক্ষায়: ${blocked.detail}`,
        })
        await recordDriveTick(plan.id, { addCostMilliTaka: reapedMilli, attempt: 'increment', now })
        return {
          planId: plan.id, goal: plan.goal, outcome: 'blocked-approval',
          detail: blocked.detail, costTaka: milliTakaToTaka(reapedMilli),
        }
      }

      if (stillWaiting.length > 0) {
        // A worker turn is genuinely in flight — don't start a second step on top
        // of it (intra-plan parallelism is deliberately not a thing here).
        await recordDriveTick(plan.id, {
          addCostMilliTaka: reapedMilli,
          nextTickAt: backoffNextTick(config, now),
          attempt: 'keep',
          now,
        })
        return {
          planId: plan.id, goal: plan.goal, outcome: 'waiting-dispatch',
          detail: `${stillWaiting.length}টা ধাপ worker-এ চলছে`, costTaka: milliTakaToTaka(reapedMilli),
        }
      }

      // A reaped VERIFY step is where the model's claim meets a re-measurement,
      // and a reaped REGRESSION step is where we find out whether our own fixes
      // broke something. Both run deterministically, here, off the plan's own
      // steps — never from the turn's narrative.
      for (const r of reaped.filter((x) => x.outcome === 'done')) {
        const s = plan.steps.find((x) => x.id === r.stepId)
        if (!s) continue
        const post = await afterGrindStep(plan.id, s).catch((err) => {
          console.warn('[grind] post-step check failed:', err instanceof Error ? err.message : err)
          return null
        })
        if (post?.halted) {
          return await escalate(plan, 'escalated-gate', `ফিক্স করতে গিয়ে বারবার নতুন সমস্যা হচ্ছে — ${post.detail}`)
        }
      }

      const progressed = reaped.some((r) => r.outcome === 'done')
      await recordDriveTick(plan.id, {
        addCostMilliTaka: reapedMilli,
        attempt: progressed ? 'reset' : 'increment',
        now,
      })
      // The in-memory plan is now stale (steps just changed) — reload before
      // deciding anything else.
      const fresh = await loadPlan(plan.id)
      if (fresh) plan = fresh
    }

    // 1. Per-plan cost cap — a hard stop that needs the owner to lift. The owner can
    //    grant THIS plan extra budget from the Live Desk (per-plan KV override),
    //    which takes precedence over the global cap. Arithmetic is milli-taka:
    //    whole-taka rounding used to bill 1৳ for a 0.1৳ turn and hit the cap on
    //    imaginary spend.
    const capOverride = await getPlanCapOverrideTaka(plan.id)
    const effectiveCap = Math.max(config.planCapTaka, capOverride)
    if (effectiveCap > 0 && plan.costMilliTaka >= effectiveCap * 1000) {
      return await escalate(
        plan,
        'escalated-cap',
        `প্ল্যানের খরচ সীমা ছুঁয়েছে (${milliTakaToTaka(plan.costMilliTaka)}/${effectiveCap} টাকা)। এগোতে অনুমতি দিন।`,
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

    // 2b. G6 — the time budget. Ordinary work finishes inside it; work that
    //     cannot must SAY so rather than sitting silently for hours (owner
    //     ruling 2026-07-26 — he watched two plans go quiet for an hour).
    if (isOverBudget(plan, await planBudgetMs(), now)) {
      return await escalate(
        plan,
        'escalated-attempts',
        `${elapsedBn(plan, now)} ধরে চলছে কিন্তু শেষ হয়নি — এখানে আমার নিজের চেষ্টায় হচ্ছে না। ` +
          `যা হয়েছে: ${plan.steps.filter((s) => s.status === 'done').length}/${plan.steps.length} ধাপ। কীভাবে এগোবো বলুন।`,
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
      // A grind campaign is finished by ARITHMETIC, not by asking a model: open
      // === 0 && claimedOnly === 0 && regressed === 0 && introduced === 0 and the
      // last measurement is newer than the last fix. Zero tokens, nothing to talk
      // past. Ordinary plans keep the existing (small) LLM gate.
      const grind = await grindCompletionForPlan(plan.id)
      if (grind) {
        if (grind.done) {
          await updatePlanStatus(plan.id, 'done', grind.reason)
          await setAutodriveState(plan.id, 'done', { selfCheckNote: grind.reason })
          await recordDriveTick(plan.id, { attempt: 'reset', now })
          void notifyOwnerIfAway({
            tier: 1,
            title: 'সব ঠিক হয়েছে ✅',
            message: `"${plan.goal}" — ${grind.reason}`,
            category: 'report',
          }).catch(() => {})
          await deliverPlanOutcome(plan, 'done', grind.reason).catch(() => {})
          return { planId: plan.id, goal: plan.goal, outcome: 'plan-done', detail: grind.reason, costTaka: 0 }
        }
        // Steps are done but the measurement disagrees — that IS the signal to
        // keep grinding, so escalate only after the normal stall budget.
        await recordDriveTick(plan.id, { nextTickAt: backoffNextTick(config, now, 'retry'), attempt: 'increment', now })
        return await escalate(plan, 'escalated-gate', `এখনো শেষ নয় — ${grind.reason}`)
      }

      const verdict = await runCompletionGate(plan, config.gateModel, { conversationId: plan.conversationId })
      const gateMilli = usdToMilliTaka(verdict.costUsd)
      const gateTaka = milliTakaToTaka(gateMilli)
      if (verdict.done) {
        await updatePlanStatus(plan.id, 'done', verdict.reason)
        await setAutodriveState(plan.id, 'done', { selfCheckNote: verdict.reason })
        await recordDriveTick(plan.id, { addCostMilliTaka: gateMilli, attempt: 'reset', now })
        // If this plan was born from a stuck daily todo, close that todo too.
        await completeSourceTodoForPlan(plan.id).catch(() => {})
        void notifyOwnerIfAway({
          tier: 1,
          title: 'Plan-Driver — সম্পন্ন ✅',
          message: `"${plan.goal}" শেষ হয়েছে। ${verdict.reason}`,
          category: 'report',
        }).catch(() => {})
        await deliverPlanOutcome(plan, 'done', verdict.reason).catch(() => {})
        return { planId: plan.id, goal: plan.goal, outcome: 'plan-done', detail: verdict.reason, costTaka: gateTaka }
      }
      // Steps ran but the goal is not truly met. Two paths:
      //  - auto-repair ON and under the repair ceiling → append ONE corrective step
      //    (the gate's reason becomes the new step's action) and keep driving. The
      //    frozen 'done' steps would re-fail the gate forever, so we must add NEW
      //    work for the next tick to act on, not just re-run the gate.
      //  - otherwise → escalate to the owner, as before.
      if (config.autoRepair && countRepairSteps(plan) < config.maxRepairSteps) {
        await appendCorrectiveStep(plan.id, `সংশোধন: ${verdict.reason}`)
        await setAutodriveState(plan.id, 'driving', { nextTickAt: backoffNextTick(config, now, 'retry') })
        await recordDriveTick(plan.id, { addCostMilliTaka: gateMilli, attempt: 'increment', now })
        return { planId: plan.id, goal: plan.goal, outcome: 'repair-queued', detail: verdict.reason, costTaka: gateTaka }
      }
      await recordDriveTick(plan.id, { addCostMilliTaka: gateMilli, attempt: 'increment', now })
      return await escalate(plan, 'escalated-gate', `যাচাই: ${verdict.reason}`)
    }

    // 5. Pick the next ready step and execute exactly one.
    const ready = getReadySteps(plan, now)
    if (ready.length === 0) {
      // A failed step still under its own ceiling is simply WAITING OUT its retry
      // backoff — that is not stuck. Come back when the earliest one is due
      // instead of escalating a plan that is going to retry itself.
      const waiting = plan.steps
        .filter((s) => s.status === 'failed' && s.attemptCount < s.maxAttempts && s.nextAttemptAt)
        .map((s) => s.nextAttemptAt as Date)
        .sort((a, b) => a.getTime() - b.getTime())
      if (waiting.length > 0 && !hasExhaustedStep(plan)) {
        await setAutodriveState(plan.id, 'driving', { nextTickAt: waiting[0] })
        await recordDriveTick(plan.id, { attempt: 'keep', now })
        return {
          planId: plan.id, goal: plan.goal, outcome: 'waiting-retry',
          detail: `আবার চেষ্টা করবে ${waiting[0].toISOString()}`, costTaka: 0,
        }
      }
      // Genuinely stuck: a step exhausted its retries, or a dependency can never
      // complete.
      const failedNote = check.failedSteps.length > 0
        ? `আটকে আছে — ব্যর্থ ধাপ: ${check.failedSteps.join(', ')}`
        : 'কোনো ধাপ এগোনোর মতো প্রস্তুত নেই (নির্ভরতা অসম্পূর্ণ)।'
      return await escalate(plan, 'escalated-stuck', failedNote)
    }

    const step = ready[0]

    // 5a. Grind pre-flight — a fix step whose findings have no real root cause is
    //     NOT dispatched (its family's diagnosis is re-queued instead), and an
    //     unapproved family runs in proposal mode. Deterministic and fail-safe:
    //     when the gate cannot confirm a cause, nothing is changed.
    const preflight = await preflightGrindStep(plan.id, step)
    if (!preflight.allow) {
      await setAutodriveState(plan.id, 'driving', { nextTickAt: backoffNextTick(config, now, 'retry') })
      await recordDriveTick(plan.id, { attempt: 'increment', now })
      return {
        planId: plan.id, goal: plan.goal, outcome: 'step-failed',
        detail: preflight.reason ?? 'root-cause gate', costTaka: 0,
      }
    }

    await markStepRunning(step.id)
    const res = await executeStep(plan, step, {
      businessId,
      driverModelId: config.driverModel,
      directiveSuffix: preflight.directiveSuffix,
    })
    const stepMilli = usdToMilliTaka(res.costUsd)
    const stepTaka = milliTakaToTaka(stepMilli)

    // 5a. Queue mode — the step turn is now running on the worker. Park the plan;
    //     the reap phase above books the verdict on a later tick. This is what
    //     removes the 110s/120s/30s timeout mismatch: the tick no longer carries
    //     the work it started.
    if (res.dispatched && res.turnId) {
      await markStepDispatched(step.id, res.turnId, now)
      await setAutodriveState(plan.id, 'driving', { nextTickAt: backoffNextTick(config, now) })
      await recordDriveTick(plan.id, { attempt: 'keep', now })
      return { planId: plan.id, goal: plan.goal, outcome: 'step-dispatched', detail: step.action, costTaka: 0 }
    }

    // 5b. Needs owner approval → park as blocked, and put the step BACK to
    //     pending. Leaving it 'running' (the old behaviour) meant getReadySteps
    //     could never pick it up again, so approving the card deadlocked the plan.
    if (res.blocked) {
      await markStepBlocked(step.id)
      await setAutodriveState(plan.id, 'blocked', {
        nextTickAt: backoffNextTick(config, now, 'retry'),
        selfCheckNote: `অনুমোদনের অপেক্ষায়: ${step.action}`,
      })
      await recordDriveTick(plan.id, { addCostMilliTaka: stepMilli, attempt: 'increment', now })
      void notifyOwnerIfAway({
        tier: 2,
        title: 'Plan-Driver — অনুমোদন দরকার',
        message: `"${plan.goal}" — "${step.action}" এর জন্য আপনার অনুমোদন দরকার।`,
        category: 'task',
      }).catch(() => {})
      return { planId: plan.id, goal: plan.goal, outcome: 'blocked-approval', detail: step.action, costTaka: stepTaka }
    }

    // 5c. Hard failure → count the attempt on the STEP and schedule its retry
    //     window (markStepFailed). The plan keeps driving; only an exhausted step
    //     escalates.
    if (res.error) {
      await markStepFailed(step.id, res.error, now)
      await recordDriveTick(plan.id, { addCostMilliTaka: stepMilli, nextTickAt: backoffNextTick(config, now, 'retry'), attempt: 'increment', now })
      return { planId: plan.id, goal: plan.goal, outcome: 'step-failed', detail: res.error, costTaka: stepTaka }
    }

    // 5e. Progress → mark the step done, reset the stall counter, keep driving.
    await markStepDone(step.id, res.summary)
    const post = await afterGrindStep(plan.id, step).catch((err) => {
      console.warn('[grind] post-step check failed:', err instanceof Error ? err.message : err)
      return null
    })
    if (post?.halted) {
      await recordDriveTick(plan.id, { addCostMilliTaka: stepMilli, attempt: 'increment', now })
      return await escalate(plan, 'escalated-gate', `ফিক্স করতে গিয়ে বারবার নতুন সমস্যা হচ্ছে — ${post.detail}`)
    }
    await setAutodriveState(plan.id, 'driving', { nextTickAt: backoffNextTick(config, now) })
    await recordDriveTick(plan.id, { addCostMilliTaka: stepMilli, attempt: 'reset', now })
    return {
      planId: plan.id, goal: plan.goal, outcome: 'step-done',
      detail: post?.detail ? `${step.action} — ${post.detail}` : step.action,
      costTaka: stepTaka,
    }
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
