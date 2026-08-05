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
  await prisma.agentKvSetting.delete({ where: { key: hopsKey(conversationId) } }).catch(() => {})
}

/** The resume instruction the next hop wakes up to. */
export function buildResumeDirective(hops: number, summary: string): string {
  return (
    `[SELF-CONTINUE — hop ${hops}] আগের টার্ন থেমেছে, কিন্তু durable completion criteria অনুযায়ী কাজ শেষ হয়নি। ` +
    `Boss নতুন কিছু বলেননি; তুমি নিজেই নিজের কাজ চালিয়ে যাচ্ছ।\n\n` +
    (summary ? `আগের টার্নে যেখানে ছিলে:\n${summary}\n\n` : '') +
    `নিয়ম:\n` +
    `- যা আগে হয়ে গেছে তা আবার কোরো না — checkpoint/আগের ধাপ পড়ে ঠিক পরের কাজ থেকে ধরো।\n` +
    `- আবার শুরু থেকে পরিকল্পনা বোলো না; কাজটা এগোও।\n` +
    `- এই টার্নেও শেষ না হলে আবার একই ভাবে নিজে থেকে চালিয়ে যাবে — Boss-কে জিজ্ঞেস করার দরকার নেই।\n` +
    `- সত্যিই কিছু জানার থাকলে তখনই থামবে এবং ask_user দেবে।`
  )
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
  /** What the turn had achieved when the deadline hit — becomes the resume brief. */
  summary: string
}): Promise<SelfContinueResult> {
  const { conversationId } = input
  try {
    const hops = await readHops(conversationId)
    if (!mayContinueChain(hops)) {
      await clearHops(conversationId)
      return { scheduled: false, hops, reason: 'hop limit reached — reporting instead of looping' }
    }

    const next = hops + 1
    await writeHops(conversationId, next)

    const { enqueueAgentContinuation } = await import('@/agent/lib/approval-continuation')
    await enqueueAgentContinuation({
      conversationId,
      // Carrying on with work Boss already asked for is correctness, not an
      // approval convenience — it must not depend on the auto-continue toggle.
      force: true,
      message: buildResumeDirective(next, input.summary),
    })
    return { scheduled: true, hops: next }
  } catch (err) {
    console.warn('[self-continue] could not schedule:', err instanceof Error ? err.message : err)
    return { scheduled: false, hops: 0, reason: 'schedule failed' }
  }
}
