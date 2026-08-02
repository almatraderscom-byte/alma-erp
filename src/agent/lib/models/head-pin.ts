/**
 * A job keeps its head — owner, 2026-08-02 (foundation audit P0-1).
 *
 * Head routing was decided per MESSAGE (`head-router.ts` triages every turn), so
 * one task could start on the heavy head and finish on the cheap one. The owner
 * watched the badge flip inside a single job:
 *
 *   "ALMA · GPT-5.6 Luna"        ← plans the work
 *   "ALMA · DeepSeek V4 Flash"   ← next turn of the SAME work, re-thinks it
 *
 * Nothing carries across that switch except the transcript, so the plan, the
 * in-flight tool reasoning and — worst — the weight of a correction the owner
 * just gave are all re-derived by a different model with a different voice.
 *
 * So the head is pinned to the JOB, with three bounds that keep it honest:
 *
 *   1. It EXPIRES (a pin must not leak into tomorrow's chat).
 *   2. It may only ever ESCALATE — light → heavy — never downgrade. A pin can
 *      therefore never keep a money/destructive message on a cheap head; the
 *      safety guards in head-router run BEFORE the pin is consulted.
 *   3. Listen mode ('personal') is never pinned. That tier withholds business
 *      tools on purpose; pinning it would mute the agent for the whole job.
 *
 * Cost note (owner is cost-sensitive, so state it plainly): a heavy-pinned job
 * keeps short follow-ups on the heavy head instead of dropping them to DeepSeek
 * — that costs more. In exchange a heavy pin SKIPS the paid triage classifier
 * call every turn (nothing can rank above heavy), and the light pin path is
 * unchanged. The kill switch is HEAD_TASK_PIN=off, TTL is
 * HEAD_TASK_PIN_TTL_MINUTES (default 45, same window as the work class).
 */
import { prisma } from '@/lib/prisma'
import { isKnownModelId } from '@/agent/lib/models/registry'
import type { HeadTier } from '@/agent/lib/models/head-router'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Owner kill switch — off restores the old per-message routing exactly. */
export const headPinEnabled = (): boolean => process.env.HEAD_TASK_PIN !== 'off'

/** How long a pin survives without being refreshed. Sliding: every turn extends it. */
export function headPinTtlMs(): number {
  const raw = Number(process.env.HEAD_TASK_PIN_TTL_MINUTES)
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 45
  return minutes * 60 * 1000
}

/**
 * Capability rank. A pin may be replaced only by a decision that ranks HIGHER,
 * so routing can escalate mid-job but never quietly drop to a cheaper head.
 * 'explicit' is the owner's own pick and 'personal' is listen mode — both sit at
 * the top because neither may be overridden by a triage guess.
 */
const TIER_RANK: Record<HeadTier, number> = {
  light: 0,
  marketing: 1,
  heavy: 2,
  personal: 2,
  explicit: 2,
}

export function headTierRank(tier: HeadTier): number {
  return TIER_RANK[tier] ?? 2
}

export function isHeadTier(v: unknown): v is HeadTier {
  return v === 'light' || v === 'heavy' || v === 'explicit' || v === 'marketing' || v === 'personal'
}

export interface HeadPin {
  modelId: string
  tier: HeadTier
  via: string
  until: Date
  /** True when the pin's window has already passed (continuation reads may still use it). */
  expired: boolean
}

/**
 * Read a stored pin off a conversation row. Pure — no I/O — so the decision
 * rules are unit-testable without a database.
 *
 * `allowExpired` exists for ONE caller: the approval continuation. An approval
 * can sit unanswered for hours; when the owner finally taps it, that turn is
 * still the same job and must resume on the same head, TTL or not.
 */
export function readHeadPin(
  row: { pinnedHeadModel?: unknown; pinnedHeadTier?: unknown; pinnedHeadVia?: unknown; pinnedHeadUntil?: unknown } | null | undefined,
  opts: { now?: number; allowExpired?: boolean } = {},
): HeadPin | null {
  if (!row) return null
  const now = opts.now ?? Date.now()
  const modelId = typeof row.pinnedHeadModel === 'string' ? row.pinnedHeadModel.trim() : ''
  if (!modelId || !isKnownModelId(modelId)) return null
  if (!isHeadTier(row.pinnedHeadTier)) return null
  // Listen mode is never pinned (see header) — treat a legacy/manual row as none.
  if (row.pinnedHeadTier === 'personal') return null
  const until = row.pinnedHeadUntil instanceof Date
    ? row.pinnedHeadUntil
    : typeof row.pinnedHeadUntil === 'string'
      ? new Date(row.pinnedHeadUntil)
      : null
  if (!until || !Number.isFinite(until.getTime())) return null
  const expired = until.getTime() <= now
  if (expired && !opts.allowExpired) return null
  return {
    modelId,
    tier: row.pinnedHeadTier,
    via: typeof row.pinnedHeadVia === 'string' && row.pinnedHeadVia ? row.pinnedHeadVia : 'unknown',
    until,
    expired,
  }
}

/** Load this conversation's pin. Fails to null, never throws — a lost pin costs
 * one re-triaged turn, never a wrong or unsafe one. */
export async function loadHeadPin(
  conversationId: string | null | undefined,
  opts: { now?: number; allowExpired?: boolean } = {},
): Promise<HeadPin | null> {
  if (!conversationId || !headPinEnabled()) return null
  try {
    const row = await db.agentConversation.findUnique({
      where: { id: conversationId },
      select: { pinnedHeadModel: true, pinnedHeadTier: true, pinnedHeadVia: true, pinnedHeadUntil: true },
    })
    return readHeadPin(row, opts)
  } catch (err) {
    console.warn('[head-pin] load failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Persist the head this job runs on. Called with the FINAL model of the turn
 * (after the worker-only redirect and the Monitor-disabled fallback have had
 * their say) so the pin always names a model that actually ran.
 *
 * Fire-and-forget by design: a failed write costs one re-triaged turn.
 */
export async function rememberHeadPin(
  conversationId: string | null | undefined,
  decision: { modelId: string; tier: HeadTier; via: string },
  now: number = Date.now(),
): Promise<void> {
  if (!conversationId || !headPinEnabled()) return
  // Listen mode is deliberately not a job identity — see header.
  if (decision.tier === 'personal') return
  if (!decision.modelId || !isKnownModelId(decision.modelId)) return
  try {
    await db.agentConversation.update({
      where: { id: conversationId },
      data: {
        pinnedHeadModel: decision.modelId,
        pinnedHeadTier: decision.tier,
        pinnedHeadVia: decision.via,
        pinnedHeadUntil: new Date(now + headPinTtlMs()),
      },
    })
  } catch (err) {
    console.warn('[head-pin] remember failed:', err instanceof Error ? err.message : err)
  }
}

/** Drop the pin (job finished / owner switched the chat back to auto). */
export async function clearHeadPin(conversationId: string | null | undefined): Promise<void> {
  if (!conversationId) return
  try {
    await db.agentConversation.update({
      where: { id: conversationId },
      data: { pinnedHeadModel: null, pinnedHeadTier: null, pinnedHeadVia: null, pinnedHeadUntil: null },
    })
  } catch (err) {
    console.warn('[head-pin] clear failed:', err instanceof Error ? err.message : err)
  }
}
