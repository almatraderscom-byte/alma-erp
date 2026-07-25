/**
 * Single-step executor — one head turn per plan step.
 *
 * The driver advances a plan ONE ready step at a time. Each step is executed by a
 * full head turn on the plan's drive conversation: we append a tightly-scoped
 * "driver directive" (do EXACTLY this one step, nothing else) and run the same
 * runOwnerTurn path the owner's own messages use — so the head gets full context,
 * the real tool set, the claim-verifier, and every action-level approval card,
 * with ZERO new execution surface to audit.
 *
 * S0 — QUEUE MODE (the default whenever the worker queue is configured).
 * Running the step turn INSIDE the tick was a three-way timeout mismatch: the
 * step turn was capped at 110s, the tick could loop 10 of them inside a 120s
 * serverless function, and the worker aborted its call after 30s. Real agentic
 * work (20–30 tool iterations) never fit. The step is now DISPATCHED onto the
 * same `long-agent-task` queue the app already uses for long turns; the tick
 * returns immediately and a later tick reaps the verdict (see reap.ts). Inline
 * execution remains as the fallback when no queue is configured.
 *
 * Approval handling: an autonomous turn cannot tap a confirm card. If the head
 * surfaces one (spend money, post, message staff), the executor STOPS and reports
 * `blocked` — the driver parks the plan and returns the step to 'pending', so
 * approving the card genuinely resumes it. Nothing irreversible happens unattended.
 */
import { prisma } from '@/lib/prisma'
import type { AgentEvent } from '@/agent/lib/core'
import { runOwnerTurn } from '@/agent/lib/models/run-owner-turn'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import type { Plan, PlanStep } from '@/agent/lib/planner'
import { createTurn, finalizeTurnIfRunning } from '@/agent/lib/turn-status'
import { buildTurnJobData, enqueueTurnJob, isTurnHandoffConfigured } from '@/agent/lib/turn-queue'
import { ensureDriveConversation } from '@/agent/lib/plan-driver/drive-conversation'

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

const MAX_STEP_TURN_MS = 110_000

/** Step kinds the grind engine authors. Each gets its own directive posture. */
export type StepKind = 'diagnose' | 'fix' | 'verify' | 'regression' | 'generic'

/**
 * A step's kind, from the marker the step-builder writes into toolName. Plain
 * plans (make_plan, promote, signal-scan) have no marker and stay 'generic'.
 */
export function stepKindOf(step: Pick<PlanStep, 'toolName'>): StepKind {
  const t = step.toolName ?? ''
  if (t.startsWith('__grind_diagnose')) return 'diagnose'
  if (t.startsWith('__grind_fix')) return 'fix'
  if (t.startsWith('__grind_verify')) return 'verify'
  if (t.startsWith('__grind_regression')) return 'regression'
  return 'generic'
}

/**
 * Per-kind fences. The old single directive told every step "don't look at any
 * other step" — correct for a fix, fatal for a diagnosis, which exists precisely
 * to look wider than the symptom in front of it.
 */
const KIND_RULES: Record<StepKind, string> = {
  generic:
    '- শুধু এই ধাপটাই করো; পরিকল্পনার অন্য ধাপ এখন ছুঁয়ো না।\n',
  diagnose:
    '- এটা DIAGNOSIS ধাপ: এখানে কিছু "ঠিক" করার চেষ্টা কোরো না। আসল কারণ বের করো।\n' +
    '- উপসর্গ নয়, মূল কারণ — দরকার হলে অন্য পেজ/ফাইল/ডেটাও দেখো, একটার মধ্যে আটকে থেকো না।\n' +
    '- প্রতিটা সমস্যার জন্য record_root_cause দিয়ে কারণ + প্রমাণ (file:line বা URL) লিখে রাখো।\n' +
    '- কারণ না বুঝে অনুমান লিখবে না — না জানলে "জানি না" লেখো, তাতেই পরের ধাপ থামবে।\n',
  fix: '- এটা FIX ধাপ: শুধু এই ব্যাচের সমস্যাগুলো ঠিক করো, নতুন কিছু শুরু কোরো না।\n' +
    '- আগের diagnose ধাপে লেখা মূল কারণ ধরে কাজ করো। কারণটা যদি এই সমস্যাটাকে ব্যাখ্যা না করে, ' +
    'তাহলে অন্ধভাবে ঠিক না করে সেটাকে needs_rediagnosis চিহ্নিত করো।\n',
  verify:
    '- এটা VERIFY ধাপ: নতুন করে কিছু ঠিক কোরো না — শুধু আবার মেপে দেখো আসলেই ঠিক হয়েছে কিনা।\n' +
    '- "মনে হচ্ছে ঠিক আছে" নয়; টুল দিয়ে আসল অবস্থা মেপে ফলাফল লেখো।\n',
  regression:
    '- এটা REGRESSION ধাপ: আগের ফিক্সগুলো নতুন কোনো সমস্যা বানিয়েছে কিনা দেখো।\n' +
    '- নতুন সমস্যা পেলে সেটা লুকিও না — পরিষ্কার করে জানাও, ওটাই এখন সবচেয়ে জরুরি।\n',
}

/**
 * Build the one-step directive the head sees. Bangla, owner-voice rules, and a
 * kind-appropriate fence.
 */
export function buildDirective(plan: Pick<Plan, 'goal'>, step: PlanStep, suffix?: string): string {
  const toolHint = step.toolName && !step.toolName.startsWith('__') ? `\nসম্ভাব্য টুল: ${step.toolName}` : ''
  const kind = stepKindOf(step)
  const retryNote =
    step.attemptCount > 0
      ? `\n[এটা ${step.attemptCount + 1} নম্বর চেষ্টা — আগের বার যা কাজ করেনি সেটাই আবার কোরো না। ` +
        `আগের ভুল: ${(step.error ?? 'অজানা').slice(0, 200)}]\n`
      : ''
  return (
    `[স্বয়ংক্রিয় Plan-Driver — একটি ধাপ অটো-এক্সিকিউশন]\n` +
    `সামগ্রিক লক্ষ্য: ${plan.goal}\n\n` +
    `এখন শুধু নিচের একটি ধাপ সম্পন্ন করো (পরের ধাপে যেও না):\n` +
    `▶ ${step.action}${toolHint}\n` +
    retryNote +
    `\nনিয়ম:\n` +
    KIND_RULES[kind] +
    `- "করছি / দেখি" বলে থেমে যেও না — দরকারি টুল আসলেই কল করো এবং ফল যাচাই করো।\n` +
    `- টাকা খরচ / পোস্ট / স্টাফ-মেসেজের মতো ধাপ হলে যথারীতি approval card দাও (আমি অনুমোদন না দিলে এগোবে না)।\n` +
    `- শেষে ১–২ লাইনে বাংলায় সংক্ষেপে Boss-কে জানাও আসলে কী হলো।` +
    (suffix ?? '')
  )
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
    /** Extra rules for THIS dispatch (e.g. grind proposal mode). */
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

  const directive = buildDirective(plan, step, opts.directiveSuffix)

  // ── Queue mode ────────────────────────────────────────────────────────────
  if (!opts.forceInline && isTurnHandoffConfigured()) {
    const turnId = await createTurn(conversationId, {
      executionMode: 'worker',
      instructionOrigin: 'owner_policy',
    })
    if (turnId) {
      const jobData = buildTurnJobData(turnId, conversationId, {
        message: directive,
        internalControl: true,
      })
      const jobId = jobData ? await enqueueTurnJob(jobData) : null
      if (jobId) {
        return { ok: false, summary: '', costUsd: 0, blocked: false, dispatched: true, turnId }
      }
      // Could not enqueue → close the orphan turn and fall through to inline.
      await finalizeTurnIfRunning(turnId, 'error').catch(() => {})
    }
    console.warn('[plan-driver] queue dispatch unavailable — running the step inline')
  }

  // ── Inline mode (no worker queue configured) ──────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  // Persist the directive as a user turn so runOwnerTurn picks it up as the latest
  // owner message (and the owner sees an auditable trail of what the driver asked).
  try {
    await db.agentMessage.create({
      data: {
        conversationId,
        role: 'user',
        content: [{ type: 'text', text: directive }],
      },
    })
  } catch (err) {
    return {
      ok: false,
      summary: '',
      costUsd: 0,
      blocked: false,
      error: `failed to enqueue driver directive: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Inline steps still run under owner_policy: the turn row carries the origin,
  // and runOwnerTurn reads it once at the start of the turn.
  const inlineTurnId = await createTurn(conversationId, {
    executionMode: 'inline',
    instructionOrigin: 'owner_policy',
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MAX_STEP_TURN_MS)

  let summary = ''
  let costUsd = 0
  let blocked = false
  let pendingActionId: string | undefined
  let error: string | undefined

  try {
    const stream: AsyncGenerator<AgentEvent> = runOwnerTurn(conversationId, {
      modelId: opts.driverModelId, // explicit → resolveHeadModelId runs THIS model, no triage
      businessId: opts.businessId,
      signal: controller.signal,
      turnId: inlineTurnId,
    })

    for await (const ev of stream) {
      switch (ev.type) {
        case 'text_delta':
          summary += ev.delta
          break
        case 'verification_retry':
          // The head made an unverified claim and is retrying — drop the partial
          // text, mirroring how the chat route resets finalText on this event.
          summary = ''
          break
        case 'confirm_card':
          // An action needs the owner. Park; do not auto-approve.
          blocked = true
          pendingActionId = ev.pendingActionId
          break
        case 'model_switch_required':
          // A premium upgrade cannot be approved unattended — park as blocked.
          blocked = true
          break
        case 'error':
          error = ev.message
          break
        case 'done':
          costUsd = ev.costUsd ?? 0
          break
        default:
          break
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      error = err instanceof Error ? err.message : String(err)
    } else {
      error = 'step head turn timed out'
    }
  } finally {
    clearTimeout(timer)
    await finalizeTurnIfRunning(inlineTurnId, error ? 'error' : 'done').catch(() => {})
  }

  const cleanSummary = summary.trim()
  const ok = !error && !blocked
  return {
    ok,
    summary: cleanSummary || (ok ? 'ধাপ সম্পন্ন হয়েছে।' : ''),
    costUsd,
    blocked,
    pendingActionId,
    error,
  }
}
