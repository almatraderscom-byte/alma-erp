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
 * Bounded by design — THREE brakes, not one (2026-08-24 runaway: 12 hops,
 * ~98k tokens, no report; one hop fully blocked by the owner-input binding
 * guard yet the chain kept going):
 *
 *  1. HOP BUDGET — the per-conversation counter (MAX_SELF_CONTINUE_HOPS).
 *  2. DRY-HOP BRAKE — a hop that ends with zero NEW successful tool results is
 *     "dry"; MAX_CONSECUTIVE_DRY_HOPS dry hops in a row stop the chain honestly
 *     instead of paying for more hops that visibly achieve nothing.
 *  3. HALT MARKER — a hop that was blocked by a binding/authority guard calls
 *     haltSelfContinueChain(); a halted chain refuses every further schedule
 *     until a genuine owner message resets it. The stop reason is persisted so
 *     the tracker/checkpoint can show WHY the agent stopped.
 *
 * The existing cost caps and the unanswered-ask-card block still apply on top —
 * a question to Boss stops everything. Owner "continue" (any real message on
 * the conversation) is the only override: resetSelfContinueChain() clears all
 * three brakes so a renewed budget starts fresh.
 */
import { prisma } from '@/lib/prisma'
import { mayContinueChain } from '@/agent/lib/continuation-policy'

const HOPS_PREFIX = 'self_continue_hops:'
const DRY_PREFIX = 'self_continue_dry:'
const STOP_PREFIX = 'self_continue_stop:'

/** ~30s: long enough for the function to unwind, short enough to feel continuous. */
export const SELF_CONTINUE_DELAY_MS = 30_000

/**
 * Two consecutive hops with zero new successful tool results = the chain is
 * spinning, not working. Two (not one) because a single hop can legitimately be
 * all model reasoning (e.g. compiling the final report from earlier tool data)
 * — but two in a row means the next hop will not be different either.
 */
export const MAX_CONSECUTIVE_DRY_HOPS = 2

const hopsKey = (conversationId: string) => `${HOPS_PREFIX}${conversationId}`
const dryKey = (conversationId: string) => `${DRY_PREFIX}${conversationId}`
const stopKey = (conversationId: string) => `${STOP_PREFIX}${conversationId}`

async function readIntKey(key: string): Promise<number> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key } })
    const n = row?.value ? parseInt(row.value, 10) : 0
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

async function writeKey(key: string, value: string): Promise<void> {
  await prisma.agentKvSetting
    .upsert({ where: { key }, update: { value }, create: { key, value } })
    .catch(() => {})
}

export async function readHops(conversationId: string): Promise<number> {
  return readIntKey(hopsKey(conversationId))
}

async function writeHops(conversationId: string, hops: number): Promise<void> {
  await writeKey(hopsKey(conversationId), String(hops))
}

/** Why a chain stopped, persisted so the tracker/checkpoint can show it. */
export type SelfContinueStopReason = 'hop_limit' | 'no_progress' | 'authority_blocked'

export interface SelfContinueStop {
  reason: SelfContinueStopReason
  hops: number
  at: string
  /** Free-form detail (e.g. which guard blocked the hop). */
  detail?: string
}

export async function readSelfContinueStop(conversationId: string): Promise<SelfContinueStop | null> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: stopKey(conversationId) } })
    if (!row?.value) return null
    const parsed: unknown = JSON.parse(row.value)
    if (
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && typeof (parsed as SelfContinueStop).reason === 'string'
    ) return parsed as SelfContinueStop
    return null
  } catch {
    return null
  }
}

async function writeStop(conversationId: string, stop: SelfContinueStop): Promise<void> {
  await writeKey(stopKey(conversationId), JSON.stringify(stop))
}

/**
 * A hop that was refused by a binding/authority guard (owner-input binding,
 * continuation binding) must NOT get a successor: the guard means this chain no
 * longer has valid execution authority, and every further hop would hit the
 * same wall and bill Boss for it (live 2026-08-24: the chain kept scheduling
 * past a fully blocked hop, all the way to hop 12). The stop reason survives
 * durably; a genuine owner message resets it.
 */
export async function haltSelfContinueChain(
  conversationId: string,
  detail: string,
): Promise<void> {
  const hops = await readHops(conversationId)
  await writeStop(conversationId, {
    reason: 'authority_blocked',
    hops,
    at: new Date().toISOString(),
    detail: detail.slice(0, 200),
  })
}

/**
 * A genuine owner message renews the budget: hops, dry counter and any stop
 * marker all clear, so "continue" (or any fresh instruction) starts a fresh
 * chain. This is the ONLY override for a braked chain — deliberately owner-only.
 */
export async function resetSelfContinueChain(conversationId: string): Promise<void> {
  await prisma.agentKvSetting
    .deleteMany({
      where: { key: { in: [hopsKey(conversationId), dryKey(conversationId), stopKey(conversationId)] } },
    })
    .catch(() => {})
}

/**
 * Engine-authored directives (heartbeat wake, self-continue resume) persist as
 * role=user rows but are NOT Boss speaking — they must never renew the hop
 * budget the way a real owner message does.
 */
export function isEngineDirectiveText(text: string): boolean {
  return /^\[(?:স্বয়ংক্রিয় হার্টবিট|SELF-CONTINUE)/.test(text.trim())
}

/** A turn that finished its work resets the chain. */
export async function clearHops(conversationId: string): Promise<void> {
  // Terminal cleanup can run more than once (for example, the stream owner and
  // its durable reconciliation path may both observe completion). `delete`
  // raises Prisma P2025 when the first cleanup already removed the row, which
  // Prisma logs even though this fail-open call catches the rejection.
  await prisma.agentKvSetting
    .deleteMany({
      where: { key: { in: [hopsKey(conversationId), dryKey(conversationId), stopKey(conversationId)] } },
    })
    .catch(() => {})
}

export interface SelfContinueResult {
  scheduled: boolean
  hops: number
  reason?: string
  /** Set when a brake (not a transport failure) stopped the chain. */
  stop?: SelfContinueStopReason
}

/**
 * What THIS hop actually achieved. `successfulToolResults` is the count of NEW
 * successful tool calls made by the hop that is asking to continue — zero means
 * the hop was dry. Callers that cannot measure it omit the field (fail-open:
 * the dry brake only engages on measured hops).
 */
export interface SelfContinueProgress {
  successfulToolResults: number
}

/**
 * Schedule the next hop of the same task. Fail-open on transport: if anything
 * here breaks the turn still ends cleanly with its checkpoint, and Boss can
 * type "continue". Fail-CLOSED on the three brakes above.
 */
export async function scheduleSelfContinue(input: {
  conversationId: string
  /** Exact predecessor whose persisted checkpoint/workflow authorizes the wake. */
  sourceTurnId: string
  /** This hop's measured progress; drives the dry-hop brake. */
  progress?: SelfContinueProgress
}): Promise<SelfContinueResult> {
  const { conversationId } = input
  const sourceTurnId = input.sourceTurnId.trim()
  if (!sourceTurnId) {
    return { scheduled: false, hops: 0, reason: 'source turn missing' }
  }
  try {
    const hops = await readHops(conversationId)

    // Brake 3 — a guard already halted this chain; nothing schedules until a
    // genuine owner message resets it.
    const stopped = await readSelfContinueStop(conversationId)
    if (stopped) {
      return {
        scheduled: false,
        hops,
        reason: `chain halted (${stopped.reason})${stopped.detail ? `: ${stopped.detail}` : ''}`,
        stop: stopped.reason,
      }
    }

    // Brake 1 — the hop budget.
    if (!mayContinueChain(hops)) {
      await writeStop(conversationId, { reason: 'hop_limit', hops, at: new Date().toISOString() })
      return { scheduled: false, hops, reason: 'hop limit reached — reporting instead of looping', stop: 'hop_limit' }
    }

    // Brake 2 — the dry-hop brake, only on measured hops.
    if (input.progress) {
      const prevDry = await readIntKey(dryKey(conversationId))
      const dry = input.progress.successfulToolResults > 0 ? 0 : prevDry + 1
      if (dry >= MAX_CONSECUTIVE_DRY_HOPS) {
        await writeStop(conversationId, {
          reason: 'no_progress',
          hops,
          at: new Date().toISOString(),
          detail: `${dry} consecutive hops with zero new successful tool results`,
        })
        return {
          scheduled: false,
          hops,
          reason: `${dry} consecutive dry hops — stopping instead of burning more`,
          stop: 'no_progress',
        }
      }
      await writeKey(dryKey(conversationId), String(dry))
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
      // A wake is scheduled from INSIDE a turn that is at (or past) its own
      // deadline — the 90s inline fallback must never run here: it would eat
      // the route's 20s persistence headroom and let the platform kill the
      // request before the salvage/terminal persists (Codex P1 #850). A
      // worker-down wake defers to the durable binding instead of executing.
      inlineDeadlineAtMs: Date.now(),
    })
    if (['queued', 'completed', 'observe'].includes(enqueued.outcome)) {
      return { scheduled: true, hops: next }
    }
    if (enqueued.outcome === 'deferred') {
      // The binding is durable and retryable, but nothing server-side is
      // actually going to fire — claiming "scheduled" here would tell Boss the
      // agent resumes itself while the worker is down. Honest answer: not
      // scheduled; the client hint / owner "continue" claims the bound turn.
      return { scheduled: false, hops: next, reason: 'worker_unavailable_deferred_to_owner' }
    }
    return { scheduled: false, hops: next, reason: enqueued.status || enqueued.outcome }
  } catch (err) {
    console.warn('[self-continue] could not schedule:', err instanceof Error ? err.message : err)
    return { scheduled: false, hops: 0, reason: 'schedule failed' }
  }
}
