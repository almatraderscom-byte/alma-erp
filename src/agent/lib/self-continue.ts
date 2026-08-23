/**
 * The agent's own wake-up (owner ruling 2026-07-26).
 *
 * His words: *"এজেন্ট ১৩ মিনিট কাজ করার পর যদি কাজ শেষ না হয়, সে ওই জায়গায় কাজের
 * বর্তমান অবস্থা সেভ করবে, নিজে থেকে একটা wakeup সেট করবে ৩০-৫০ সেকেন্ড, এরপর আবার
 * নিজে থেকেই কাজ শুরু করবে — এভাবে কন্টিনিউ করে শেষ করবে। এখানে Plan-Drive-এর কোনো
 * কাজ নেই।"*
 *
 * He is right, and it is how I work in his session: hit a limit, save state, set
 * a wake-up, resume. Two things were missing here:
 *
 *  1. auto-continue only fired for BROWSER turns, so a long SEO/tool job stopped
 *     dead at the deadline (continuation-policy.ts — fixed alongside this);
 *  2. the resume was a hint to the CLIENT, so it only happened while his app was
 *     open. This module schedules it SERVER-side, on the worker queue, so the
 *     work continues whether or not he is looking.
 *
 * Bounded by design: a hop counter per conversation (MAX_SELF_CONTINUE_HOPS),
 * the existing cost caps, and the unanswered-ask-card block — a question to Boss
 * still stops everything.
 */
import { prisma } from '@/lib/prisma'
import { mayContinueChain } from '@/agent/lib/continuation-policy'

const HOPS_PREFIX = 'self_continue_hops:'

/** ~30s: long enough for the function to unwind, short enough to feel continuous. */
export const SELF_CONTINUE_DELAY_MS = 30_000

const hopsKey = (conversationId: string) => `${HOPS_PREFIX}${conversationId}`

export async function readHops(conversationId: string): Promise<number> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: hopsKey(conversationId) } })
    const n = row?.value ? parseInt(row.value, 10) : 0
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

async function writeHops(conversationId: string, hops: number): Promise<void> {
  const key = hopsKey(conversationId)
  await prisma.agentKvSetting
    .upsert({ where: { key }, update: { value: String(hops) }, create: { key, value: String(hops) } })
    .catch(() => {})
}

/** A turn that finished its work resets the chain. */
export async function clearHops(conversationId: string): Promise<void> {
  // Terminal cleanup can run more than once (for example, the stream owner and
  // its durable reconciliation path may both observe completion). `delete`
  // raises Prisma P2025 when the first cleanup already removed the row, which
  // Prisma logs even though this fail-open call catches the rejection.
  await prisma.agentKvSetting.deleteMany({ where: { key: hopsKey(conversationId) } }).catch(() => {})
}

export interface SelfContinueResult {
  scheduled: boolean
  hops: number
  reason?: string
}

/**
 * Schedule the next hop of the same task. Fail-open: if anything here breaks the
 * turn still ends cleanly with its checkpoint, and Boss can type "continue".
 */
export async function scheduleSelfContinue(input: {
  conversationId: string
  /** Exact predecessor whose persisted checkpoint/workflow authorizes the wake. */
  sourceTurnId: string
}): Promise<SelfContinueResult> {
  const { conversationId } = input
  const sourceTurnId = input.sourceTurnId.trim()
  if (!sourceTurnId) {
    return { scheduled: false, hops: 0, reason: 'source turn missing' }
  }
  try {
    const hops = await readHops(conversationId)
    if (!mayContinueChain(hops)) {
      await clearHops(conversationId)
      return { scheduled: false, hops, reason: 'hop limit reached — reporting instead of looping' }
    }

    const next = hops + 1
    const { buildSelfContinueBinding } = await import('@/agent/lib/continuation-binding')
    const binding = await buildSelfContinueBinding({ conversationId, sourceTurnId })
    await writeHops(conversationId, next)

    const { enqueueAgentContinuation } = await import('@/agent/lib/approval-continuation')
    const enqueued = await enqueueAgentContinuation({
      conversationId,
      // Carrying on with work Boss already asked for is correctness, not an
      // approval convenience — it must not depend on the auto-continue toggle.
      force: true,
      binding,
    })
    if (['queued', 'completed', 'observe', 'deferred'].includes(enqueued.outcome)) {
      return { scheduled: true, hops: next }
    }
    return { scheduled: false, hops: next, reason: enqueued.status || enqueued.outcome }
  } catch (err) {
    console.warn('[self-continue] could not schedule:', err instanceof Error ? err.message : err)
    return { scheduled: false, hops: 0, reason: 'schedule failed' }
  }
}
