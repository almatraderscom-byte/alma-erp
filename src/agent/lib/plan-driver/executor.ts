/**
 * Single-step executor — Option খ (head-turn per step), Qwen as the head.
 *
 * The driver advances a plan ONE ready step at a time. Each step is executed by a
 * full head turn on the owner's existing conversation: we append a tightly-scoped
 * "driver directive" (do EXACTLY this one step, nothing else) and run the same
 * runOwnerTurn path the owner's own messages use — so the head gets full context,
 * the real tool set, the claim-verifier, and every action-level approval card,
 * with ZERO new execution surface to audit.
 *
 * Owner decision (recorded): the head here is QWEN (`or-qwen3-max`), not Sonnet —
 * `sonnet apatoto ekhane dorkar nei`. Qwen orchestrates and hands discrete sub-work
 * to DeepSeek via delegate_to_specialist when it chooses. The model id is
 * owner-tunable (autodrive_driver_model) with no redeploy.
 *
 * Approval handling: an autonomous turn cannot tap a confirm card. If the head
 * surfaces one (spend money, post, message staff), the executor STOPS and reports
 * `blocked` — the driver parks the plan in 'blocked' and the card waits in the
 * owner's normal pending-approvals queue. Nothing irreversible happens unattended.
 */
import { prisma } from '@/lib/prisma'
import type { AgentEvent } from '@/agent/lib/core'
import { runOwnerTurn } from '@/agent/lib/models/run-owner-turn'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import type { Plan, PlanStep } from '@/agent/lib/planner'

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
}

const MAX_STEP_TURN_MS = 110_000

/**
 * Build the one-step directive the head sees. Bangla, owner-voice rules, and a hard
 * "only this step" fence so the head doesn't run ahead of the dependency graph.
 */
function buildDirective(plan: Pick<Plan, 'goal'>, step: PlanStep): string {
  const toolHint = step.toolName ? `\nসম্ভাব্য টুল: ${step.toolName}` : ''
  return (
    `[স্বয়ংক্রিয় Plan-Driver — একটি ধাপ অটো-এক্সিকিউশন]\n` +
    `সামগ্রিক লক্ষ্য: ${plan.goal}\n\n` +
    `এখন শুধু নিচের একটি ধাপ সম্পন্ন করো (পরের ধাপে যেও না):\n` +
    `▶ ${step.action}${toolHint}\n\n` +
    `নিয়ম:\n` +
    `- শুধু এই ধাপটাই করো; পরিকল্পনার অন্য ধাপ এখন ছুঁয়ো না।\n` +
    `- "করছি / দেখি" বলে থেমে যেও না — দরকারি টুল আসলেই কল করো এবং ফল যাচাই করো।\n` +
    `- টাকা খরচ / পোস্ট / স্টাফ-মেসেজের মতো ধাপ হলে যথারীতি approval card দাও (আমি অনুমোদন না দিলে এগোবে না)।\n` +
    `- শেষে ১–২ লাইনে বাংলায় সংক্ষেপে Boss-কে জানাও আসলে কী হলো।`
  )
}

/**
 * Execute one ready step of a plan via a Qwen head turn. Never throws — all
 * failures come back as `{ ok:false, error }`.
 */
export async function executeStep(
  plan: Pick<Plan, 'id' | 'goal' | 'conversationId'> & { conversationId?: string | null },
  step: PlanStep,
  opts: { businessId: AgentBusinessId; driverModelId: string },
): Promise<StepExecResult> {
  const conversationId = plan.conversationId
  if (!conversationId) {
    return {
      ok: false,
      summary: '',
      costUsd: 0,
      blocked: false,
      error: 'plan has no conversationId — cannot run a head turn',
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  // Persist the directive as a user turn so runOwnerTurn picks it up as the latest
  // owner message (and the owner sees an auditable trail of what the driver asked).
  try {
    await db.agentMessage.create({
      data: {
        conversationId,
        role: 'user',
        content: [{ type: 'text', text: buildDirective(plan, step) }],
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
          // Should not happen (Qwen is non-premium), but guard: treat as blocked.
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
