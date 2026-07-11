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
// generated media is in the conversation. Both paths funnel through this one tested
// createTurn → buildTurnJobData → enqueueTurnJob handoff the VPS worker drains.
import { prisma } from '@/lib/prisma'
import { createTurn } from '@/agent/lib/turn-status'
import { buildTurnJobData, enqueueTurnJob, isTurnHandoffConfigured } from '@/agent/lib/turn-queue'

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

/**
 * Enqueue one continuation turn for a conversation. Reuses the tested
 * createTurn → buildTurnJobData → enqueueTurnJob path; the VPS worker drains it and
 * runs the turn through the chat route (which persists the reply for the app poll AND
 * notifies Telegram), so both surfaces resume. Fully best-effort: no-ops when the
 * worker queue (Redis) isn't configured or the owner flipped the kill switch off, and
 * never throws to the caller. No infinite loop: a continuation only ever fires from a
 * human approval or a one-shot job completion, and the turn is told not to redo the work.
 */
export async function enqueueAgentContinuation(opts: { conversationId: string; message: string }): Promise<void> {
  if (!opts.conversationId) return
  if (!isTurnHandoffConfigured()) return        // no worker queue → silently skip
  if (!(await autoContinueEnabled())) return    // owner disabled it

  const turnId = await createTurn(opts.conversationId)
  const jobData = buildTurnJobData(turnId, opts.conversationId, { message: opts.message })
  if (jobData) await enqueueTurnJob(jobData)
}
