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
// is missing/stale, the continuation runs INLINE in this serverless function instead
// (the revise-route pattern: persist the directive as a user message → one
// runOwnerTurn pass → finalize the turn row). Slower and capped at 90s, but the
// chain never silently dies with the worker.
import { prisma } from '@/lib/prisma'
import { createTurn, finalizeTurnIfRunning } from '@/agent/lib/turn-status'
import { buildTurnJobData, enqueueTurnJob, isTurnHandoffConfigured } from '@/agent/lib/turn-queue'

/** Hard cap for an INLINE (serverless) continuation turn — callers' maxDuration
 * must leave headroom above this (approve and job-result both run at 120s). */
const INLINE_CONTINUATION_MAX_MS = 90_000

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

/** Run the continuation turn in-process (revise-route pattern): persist the directive
 * as a user message, drain one runOwnerTurn pass (it persists its own reply/cards),
 * then finalize the turn row so the app's resume spinner settles. Never silent. */
export async function runContinuationInline(opts: { conversationId: string; message: string }, turnId: string | null): Promise<void> {
  let spoke = false
  try {
    const { runOwnerTurn } = await import('@/agent/lib/models/run-owner-turn')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), INLINE_CONTINUATION_MAX_MS)
    try {
      for await (const ev of runOwnerTurn(opts.conversationId, {
        signal: controller.signal,
        projectSystemInstructions:
          `[INTERNAL WORKFLOW CONTINUATION — NOT an owner-authored message and never display/quote it as one.]\n${opts.message}`,
      })) {
        // A card counts as speaking too — an approval that stages the next card
        // has visibly moved the job on, even with no prose.
        if (ev.type === 'text_delta' && ev.delta.trim()) spoke = true
        if (ev.type === 'ask_card' || ev.type === 'confirm_card') spoke = true
        if (ev.type === 'error') {
          console.warn('[approval-continuation] inline turn error event:', ev.message)
        }
      }
    } finally {
      clearTimeout(timer)
    }
    if (turnId) await finalizeTurnIfRunning(turnId, 'done')
    if (!spoke) {
      console.warn('[approval-continuation] inline continuation produced no reply')
      await postSilenceBreaker(opts.conversationId, 'empty', '')
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn('[approval-continuation] inline continuation failed:', detail)
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
  }
}

/**
 * Resume the head with one continuation turn. Preferred path: the VPS worker's Redis
 * turn queue (createTurn → buildTurnJobData → enqueueTurnJob; the worker runs it via
 * the chat route so the app poll AND Telegram both resume). Fallback path: when the
 * worker's turn consumer is down (stale heartbeat) or the enqueue itself fails, the
 * turn runs INLINE in this function. Never throws to the caller. No infinite loop: a
 * continuation only ever fires from a human approval or a one-shot job completion,
 * and the turn is told not to redo the work.
 */
export async function enqueueAgentContinuation(opts: {
  conversationId: string
  message: string
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
}): Promise<void> {
  if (!opts.conversationId) return
  if (!opts.force && !(await autoContinueEnabled())) {
    if (opts.turnId) await finalizeTurnIfRunning(opts.turnId, 'done')
    return
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
      return
    }
  }

  const turnId = opts.turnId ?? (await createTurn(opts.conversationId))

  if (isTurnHandoffConfigured() && (await workerTurnConsumerAlive())) {
    const jobData = buildTurnJobData(turnId ?? '', opts.conversationId, {
      message: opts.message,
      internalControl: true,
    })
    if (jobData && turnId) {
      const jobId = await enqueueTurnJob(jobData)
      if (jobId) return                          // worker will drain it
    }
    console.warn('[approval-continuation] worker enqueue failed — falling back to inline turn')
  }

  await runContinuationInline(opts, turnId)
}
