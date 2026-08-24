// Shared "keep going" continuation enqueue. After an owner approval (synchronous
// actions) OR an async generation job (image/video) genuinely COMPLETES, we resume
// the agent with one continuation turn so it carries on its task on its own instead
// of going silent until Boss messages again (owner request, issue #3).
//
// Why a shared module: the synchronous approval path (actions/[id]/approve) and the
// async worker-callback path (internal/job-result) BOTH need to resume the head, but
// at different moments. For image_gen/video_gen the artifact is produced 30–60s AFTER
// approval, so firing the continuation at approval time runs the head BEFORE the image
// exists — it can't chain to the next step (e.g. an Instagram post) and stalls. The
// async path therefore owns the continuation for those types, firing only once the
// generated media is in the conversation.
//
// Delivery has TWO legs (2026-07-13, owner incident: image approved → agent went
// silent forever). The preferred leg is the tested createTurn → buildTurnJobData →
// enqueueTurnJob Redis handoff the VPS worker drains — but that consumer had been
// dead since 2026-07-02 while everything else looked healthy, so every continuation
// turn sat 'running' forever and the approve→next-step chain silently died. The
// worker now writes a turn-consumer heartbeat (agent_kv_settings.worker_heartbeat_at,
// every 60s, only while its BullMQ consumer is actually running); when that heartbeat
// is missing/stale, the continuation runs INLINE only when the caller still has
// the full safe 90s budget (the revise-route pattern). A late caller instead
// terminalizes with durable continuationNeeded, which the app claims exactly once.
import type { AgentBusinessId } from '@/lib/agent-api/business-context'
import { prisma } from '@/lib/prisma'
import { finalizeTurnIfRunning, linkTurnAssistantMessage } from '@/agent/lib/turn-status'
import { buildTurnJobData, enqueueTurnJob, isTurnHandoffConfigured } from '@/agent/lib/turn-queue'
import { traceTurnStage } from '@/agent/lib/turn-stage-trace'
import { createTurnEventPublisher } from '@/agent/lib/turn-events'
import {
  bindContinuationTurn,
  claimContinuationExecution,
  continuationDomainForPendingActionType,
  sourceBoundContinuationsEnabled,
  type ContinuationBindingV1,
} from '@/agent/lib/continuation-binding'

/** Hard cap for an INLINE (serverless) continuation turn — callers' maxDuration
 * must leave headroom above this (approve and job-result both run at 120s). */
const INLINE_CONTINUATION_MAX_MS = 90_000
/** Final turn write/silence note must complete before the caller's own deadline. */
const INLINE_CONTINUATION_SETTLE_HEADROOM_MS = 5_000

export function hasSafeInlineContinuationBudget(
  inlineDeadlineAtMs: number | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (inlineDeadlineAtMs == null) return true
  return inlineDeadlineAtMs - nowMs
    >= INLINE_CONTINUATION_MAX_MS + INLINE_CONTINUATION_SETTLE_HEADROOM_MS
}

/** How fresh the worker's turn-consumer heartbeat must be to trust the Redis path. */
const WORKER_HEARTBEAT_FRESH_MS = 3 * 60 * 1000

/** Owner kill switch for auto-continue-after-approval. Default ON (owner asked for it);
 * set agent_kv_settings key `auto_continue_after_approval` = off to disable, no redeploy. */
export async function autoContinueEnabled(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({ where: { key: 'auto_continue_after_approval' } })
    const v = (row?.value ?? '').toString().trim().toLowerCase()
    return v !== 'off' && v !== 'false' && v !== '0'
  } catch {
    return true
  }
}

/** True when the VPS worker's TURN CONSUMER (not just the process) checked in within
 * the last 3 minutes. The worker only writes this key while its BullMQ long-agent-task
 * consumer is genuinely running, so a half-alive worker (HTTP poll loop up, Redis
 * consumer dead — the 2026-07-13 incident) correctly reads as "down" here. */
async function workerTurnConsumerAlive(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({ where: { key: 'worker_heartbeat_at' } })
    if (!row?.value) return false
    const t = Date.parse(String(row.value))
    return Number.isFinite(t) && Date.now() - t < WORKER_HEARTBEAT_FRESH_MS
  } catch {
    return false
  }
}

/**
 * SILENCE IS THE BUG (owner incident 2026-07-27). He approved an SEO batch, the
 * card said "✅ সম্পন্ন", and the agent never spoke again. Every later message he
 * saw came from someone else typing — my own test question was what woke it,
 * which is how the fault survived a "verified" session.
 *
 * The cause is not one branch: the inline continuation is capped at 90 s, and
 * BOTH failure modes below used to end in a `console.warn` the owner can never
 * see, with nothing written into the conversation.
 *
 *   1. it throws or the 90 s abort fires mid-turn — nothing persisted;
 *   2. it completes cleanly having produced NO assistant text — a "success"
 *      that says nothing, which looks exactly like the agent giving up.
 *
 * Both now end in a visible line. An honest "আমি আটকে গেছি, এই কারণে" is a far
 * better outcome than silence: the owner can act on it, and it can never be
 * mistaken for the work being finished.
 *
 * Why not simply raise the cap: the approve route's maxDuration is 120 s, so 90 s
 * is the headroom, not a guess. The real repair for the timeout is the worker
 * queue — which is down for an unrelated reason (Upstash request quota
 * exhausted, 2026-07-27), and that is exactly when this fallback has to hold.
 */
async function postSilenceBreaker(
  conversationId: string,
  reason: 'failed' | 'empty',
  detail: string,
): Promise<void> {
  try {
    const { appendAssistantNote } = await import('@/agent/lib/conversation-note')
    const text =
      reason === 'empty'
        ? 'বস, approve হওয়া কাজটার পরের ধাপে নিজে থেকে এগোতে গিয়ে আমি কিছুই ফেরত দিতে পারিনি — '
          + 'কাজটা যেখানে ছিল সেখানেই আছে, শেষ হয়নি। "চালিয়ে যাও" বললে আমি ওখান থেকেই ধরব।'
        : 'বস, approve হওয়া কাজটার পরের ধাপে নিজে থেকে এগোতে গিয়ে আমি আটকে গেছি — '
          + `কারণ: ${detail}। কাজটা শেষ হয়নি। "চালিয়ে যাও" বললে আমি ওখান থেকেই ধরব।`
    await appendAssistantNote(conversationId, text)
  } catch (err) {
    // Last resort only — if even the note fails there is nothing further to try,
    // but it must never turn an approval into an error for the owner.
    console.warn('[approval-continuation] silence-breaker note failed:', err instanceof Error ? err.message : err)
  }
}

export type ContinuationInlineResult = {
  outcome: 'completed' | 'observe' | 'failed'
  turnId: string | null
  status: 'done' | 'error' | 'running' | string
}

/**
 * Run one continuation in-process. A source-bound run first wins the same DB
 * execution CAS used by the worker chat route, then renders its directive from
 * the persisted source. Internal control is never persisted as an owner message.
 */
export async function runContinuationInline(opts: {
  conversationId: string
  message?: string
  continuationRequestId?: string
  /** Execution SCOPE the caller already validated. A Plan-Driver step for
   * ALMA_TRADING must not silently run in the ALMA_LIFESTYLE tool/data context,
   * and the owner's autodrive model must not be re-triaged away (Codex P1 #847:
   * the pre-source-binding inline path supplied both explicitly). */
  businessId?: AgentBusinessId
  modelId?: string
}, turnId: string | null): Promise<ContinuationInlineResult> {
  let spoke = false
  let terminal: 'done' | 'error' | null = null
  const boundRequestId = opts.continuationRequestId?.trim() ?? ''
  let directive = ''
  let durable: ReturnType<typeof createTurnEventPublisher> | null = null
  try {
    if (boundRequestId) {
      if (!turnId) throw new Error('continuation_turn_missing')
      const claim = await claimContinuationExecution({
        conversationId: opts.conversationId,
        turnId,
        requestId: boundRequestId,
      })
      if (claim.outcome === 'observe') {
        return { outcome: 'observe', turnId, status: claim.status }
      }
      directive = claim.directive
      durable = createTurnEventPublisher(turnId)
    } else {
      if (turnId) await finalizeTurnIfRunning(turnId, 'error')
      return { outcome: 'failed', turnId, status: 'binding_required' }
    }
    const { runOwnerTurn } = await import('@/agent/lib/models/run-owner-turn')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), INLINE_CONTINUATION_MAX_MS)
    try {
      for await (const ev of runOwnerTurn(opts.conversationId, {
        signal: controller.signal,
        // P0-1: resume on the head that was running this job. Without it the
        // inline path re-triaged from scratch, so the model that planned the
        // work was not the model that finished it after the owner's tap.
        continuation: true,
        projectSystemInstructions: directive,
        // Validated execution scope rides through the continuation; dropping it
        // ran the wrong business context and ignored the pinned driver model.
        ...(opts.businessId ? { businessId: opts.businessId } : {}),
        ...(opts.modelId ? { modelId: opts.modelId } : {}),
        // Bound internal turns need their exact DB identity all the way through routing.
        ...(boundRequestId ? { turnId } : {}),
      })) {
        durable?.emit(ev as { type: string; [k: string]: unknown })
        // A card counts as speaking too — an approval that stages the next card
        // has visibly moved the job on, even with no prose.
        if (ev.type === 'text_delta' && ev.delta.trim()) spoke = true
        if (ev.type === 'ask_card' || ev.type === 'confirm_card') spoke = true
        if (ev.type === 'error') {
          terminal = 'error'
          console.warn('[approval-continuation] inline turn error event:', ev.message)
        }
        if (ev.type === 'done') {
          terminal = 'done'
          const messageId = (ev as { messageId?: string }).messageId
          if (messageId && turnId) await linkTurnAssistantMessage(turnId, messageId)
        }
      }
    } finally {
      clearTimeout(timer)
    }
    if (boundRequestId && !terminal) {
      durable?.emit({ type: 'error', message: 'continuation_stream_ended_without_terminal' })
      terminal = 'error'
    }
    await durable?.finish()
    if (turnId) await finalizeTurnIfRunning(turnId, terminal === 'error' ? 'error' : 'done')
    if (!spoke) {
      console.warn('[approval-continuation] inline continuation produced no reply')
      await postSilenceBreaker(opts.conversationId, 'empty', '')
    }
    return {
      outcome: terminal === 'error' ? 'failed' : 'completed',
      turnId,
      status: terminal === 'error' ? 'error' : 'done',
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn('[approval-continuation] inline continuation failed:', detail)
    if (boundRequestId && !terminal) {
      durable?.emit({ type: 'error', message: detail.slice(0, 300) })
      try { await durable?.finish() } catch { /* the visible breaker is the final net */ }
    }
    if (turnId) await finalizeTurnIfRunning(turnId, 'error')
    // Text already streamed and persisted is not silence — only add the note when
    // the owner would otherwise be left with nothing.
    if (!spoke) {
      await postSilenceBreaker(
        opts.conversationId,
        'failed',
        detail.includes('abort') ? 'সময়সীমা পেরিয়ে গেছে (৯০ সেকেন্ড)' : detail.slice(0, 160),
      )
    }
    return { outcome: 'failed', turnId, status: 'error' }
  }
}

export type ContinuationEnqueueResult = {
  outcome: 'queued' | 'completed' | 'failed' | 'observe' | 'deferred' | 'disabled' | 'rejected'
  turnId: string | null
  requestId: string | null
  status: string
}

/**
 * Resume the head with one continuation turn. Preferred path: the VPS worker's Redis
 * turn queue (createTurn → buildTurnJobData → enqueueTurnJob; the worker runs it via
 * the chat route so the app poll AND Telegram both resume). Fallback path: when the
 * worker's turn consumer is down (stale heartbeat) or the enqueue itself fails, the
 * turn runs INLINE in this function when the caller has enough budget. A route near
 * its deadline persists continuation eligibility and terminalizes instead. Never
 * throws to the caller. No infinite loop: a continuation only ever fires from a
 * human approval or a one-shot job completion, and the turn is told not to redo work.
 */
export async function enqueueAgentContinuation(opts: {
  conversationId: string
  /** Compile-time compatibility only. Never used as execution authority. */
  message?: string
  /** Immutable persisted authority for the continuation. */
  binding?: ContinuationBindingV1
  /** Transport correctness (e.g. a last-moment owner steer) is not an optional
   * approval convenience and must ignore the auto-continue preference. */
  force?: boolean
  /** Reuse an already-visible progress turn (created at approve time so the app
   * shows the working spinner IMMEDIATELY) instead of opening a second one —
   * one coherent "active" span from the owner's tap to the final reply
   * (owner ask 2026-07-13: Claude-Code-like live progress). */
  turnId?: string | null
  /**
   * Resume even while an ask card is unanswered. Only for a continuation that
   * IS the owner's answer being applied (the ask-card answer route) — never for
   * background work.
   */
  ignoreAwaitingOwner?: boolean
  /**
   * Absolute caller-safe deadline. When the full 90s inline fallback plus its
   * terminal write no longer fits, persist exact-once continuation eligibility
   * instead of letting the platform kill a still-running progress turn.
   */
  inlineDeadlineAtMs?: number
  /** Test/driver fallback: use the same bound+flagged contract but skip Redis. */
  forceInline?: boolean
  /** Caller-validated execution scope, carried into the inline path. */
  businessId?: AgentBusinessId
  modelId?: string
}): Promise<ContinuationEnqueueResult> {
  if (!opts.conversationId) {
    return { outcome: 'rejected', turnId: null, requestId: null, status: 'invalid_conversation' }
  }
  if (!sourceBoundContinuationsEnabled()) {
    // Rollback stops unattended execution. It must never restore the historical
    // free-form/history path that caused cross-domain continuation routing.
    if (opts.turnId) await finalizeTurnIfRunning(opts.turnId, 'done')
    return { outcome: 'disabled', turnId: opts.turnId ?? null, requestId: null, status: 'source_binding_disabled' }
  }
  if (!opts.force && !(await autoContinueEnabled())) {
    if (opts.turnId) await finalizeTurnIfRunning(opts.turnId, 'done')
    return { outcome: 'disabled', turnId: opts.turnId ?? null, requestId: null, status: 'done' }
  }
  // An unanswered question BLOCKS the agent (owner rule 2026-07-25). Boss
  // watched a whole new turn start under a card he had not touched — a
  // server-side resume must never talk past his open question. Callers that
  // still owe him a result (job delivery) post it as a plain message instead.
  if (!opts.ignoreAwaitingOwner) {
    const { hasUnansweredAskCard } = await import('@/agent/lib/job-delivery')
    if (await hasUnansweredAskCard(opts.conversationId)) {
      console.log('[approval-continuation] skipped — Boss has an unanswered question in this conversation')
      if (opts.turnId) await finalizeTurnIfRunning(opts.turnId, 'done')
      return { outcome: 'disabled', turnId: opts.turnId ?? null, requestId: null, status: 'awaiting_owner' }
    }
  }

  if (!opts.binding) {
    console.error('[approval-continuation] rejected unbound internal continuation')
    if (opts.turnId) await finalizeTurnIfRunning(opts.turnId, 'error')
    return { outcome: 'rejected', turnId: opts.turnId ?? null, requestId: null, status: 'binding_required' }
  }
  const bound = await bindContinuationTurn({
    binding: opts.binding,
    preferredTurnId: opts.turnId,
    ...(opts.forceInline ? { executionMode: 'inline' as const } : {}),
  })
  const turnId = bound.turnId
  const requestId = bound.requestId

  if (!opts.forceInline && isTurnHandoffConfigured() && (await workerTurnConsumerAlive())) {
    const jobData = buildTurnJobData(
      turnId ?? '',
      opts.conversationId,
      { internalControl: true, continuationRequestId: bound.requestId },
    )
    if (jobData && turnId) {
      const jobId = await enqueueTurnJob(jobData)
      if (jobId) {
        // P0-2: everything after this stamp happens in another process. The gap
        // to `route_received` IS the queue hop — the part the audit could only
        // call "unverified".
        await traceTurnStage(turnId, 'continuation_enqueued', 'worker')
        return { outcome: 'queued', turnId, requestId, status: 'running' }
      }
    }
    console.warn('[approval-continuation] worker enqueue failed — falling back to inline turn')
  }

  if (!hasSafeInlineContinuationBudget(opts.inlineDeadlineAtMs)) {
    await traceTurnStage(turnId, 'continuation_enqueued', 'client_budget')
    // A bound turn stays unclaimed and retryable by the same request id. Its
    // source (notably an open task) is still open because execution never won.
    return { outcome: 'deferred', turnId, requestId, status: 'running' }
  }

  await traceTurnStage(turnId, 'continuation_enqueued', 'inline')
  const inline = await runContinuationInline({
    conversationId: opts.conversationId,
    continuationRequestId: bound.requestId,
    ...(opts.businessId ? { businessId: opts.businessId } : {}),
    ...(opts.modelId ? { modelId: opts.modelId } : {}),
  }, turnId)
  return {
    outcome: inline.outcome === 'observe'
      ? 'observe'
      : inline.outcome === 'completed' ? 'completed' : 'failed',
    turnId,
    requestId,
    status: inline.status,
  }
}

/**
 * Resume the conversation after a pending action has genuinely finished.
 *
 * Kept beside the generic continuation transport so both the synchronous
 * approval route and delayed Mac visual-proof reconciliation use the exact
 * same completion facts and owner-facing instruction. In particular, a Mac
 * action whose AFTER screenshot arrives after the approval request timed out
 * must resume here, not stop at the proof note.
 */
export async function enqueueApprovedActionContinuation(
  actionId: string,
  reuseTurnId: string | null = null,
  options: { inlineDeadlineAtMs?: number } = {},
): Promise<void> {
  // Whatever early-return path we take below, a progress turn opened at approve
  // time must not stay 'running' forever — except for renders/calls, whose
  // terminal callback owns that turn.
  const settleProgress = async (actionType?: string) => {
    if (reuseTurnId && actionType !== 'image_gen' && actionType !== 'video_gen' && actionType !== 'agent_voice_call') {
      await finalizeTurnIfRunning(reuseTurnId, 'done')
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const action = await db.agentPendingAction.findUnique({
    where: { id: actionId },
    select: { conversationId: true, status: true, type: true, workflowRunId: true },
  })
  const conversationId: string | null = action?.conversationId ?? null
  if (!conversationId) { await settleProgress(action?.type); return }
  if (action.status !== 'approved' && action.status !== 'executed') {
    await settleProgress(action.type)
    return
  }

  // These jobs are not complete at approval time. Their own terminal callback
  // owns the continuation after the artifact/call report is durable.
  if (action.type === 'image_gen' || action.type === 'video_gen' || action.type === 'agent_voice_call') return

  await enqueueAgentContinuation({
    conversationId,
    binding: {
      v: 1,
      origin: 'approval',
      source: { kind: 'pending_action', id: actionId },
      conversationId,
      domain: continuationDomainForPendingActionType(action.type),
      event: 'action_executed',
      ...(action.workflowRunId ? { workflowRunId: String(action.workflowRunId) } : {}),
      directive: { kind: 'approved_action_completed', version: 1 },
      expected: {
        sourceStatus: [String(action.status)],
        sourceType: String(action.type),
      },
    },
    turnId: reuseTurnId,
    ignoreAwaitingOwner: true,
    inlineDeadlineAtMs: options.inlineDeadlineAtMs,
  })
}
