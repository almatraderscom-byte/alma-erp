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

/** Every tier that ranks at or below `tier` — the only pins a new decision may overwrite. */
function tiersAtOrBelow(tier: HeadTier): HeadTier[] {
  const ceiling = headTierRank(tier)
  return (Object.keys(TIER_RANK) as HeadTier[]).filter((t) => TIER_RANK[t] <= ceiling)
}

/**
 * Persist the head this job runs on. Called with the FINAL model of the turn
 * (after the worker-only redirect and the Monitor-disabled fallback have had
 * their say) so the pin always names a model that actually ran.
 *
 * Two properties the naive version got wrong (review bot, #690):
 *
 *  - **The window does not slide.** Refreshing the expiry on every turn means a
 *    chat that is used all day never drops its heavy pin, and one heavy question
 *    silently owns the routing of everything after it. The expiry is therefore
 *    absolute — set when the pin is TAKEN — so a job ages out 45 minutes after
 *    it started and normal per-message routing resumes. Re-writing an identical,
 *    still-live pin is skipped entirely (it would slide the window and churn the
 *    row for nothing).
 *  - **The write cannot downgrade.** Never-downgrade was enforced only while
 *    routing one turn; two overlapping turns could land their fire-and-forget
 *    writes out of order and let a light decision replace a heavy pin. The
 *    update is now a single conditional statement — the tier filter lives in the
 *    WHERE clause, so a lower-ranked write against a live higher pin matches no
 *    row and changes nothing.
 *
 * Fire-and-forget by design: a failed write costs one re-routed turn.
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
  const nowDate = new Date(now)
  try {
    await db.agentConversation.updateMany({
      where: {
        id: conversationId,
        // May write when there is no live pin at all, or when the live pin ranks
        // at or below this decision (equal rank = the same job continuing, a
        // higher rank = an escalation). A live HIGHER pin matches nothing here.
        OR: [
          { pinnedHeadModel: null },
          { pinnedHeadUntil: null },
          { pinnedHeadUntil: { lte: nowDate } },
          { pinnedHeadTier: { in: tiersAtOrBelow(decision.tier) } },
        ],
        // …but not when it would only re-stamp the pin that is already live:
        // that is the window-sliding bug.
        NOT: {
          pinnedHeadModel: decision.modelId,
          pinnedHeadTier: decision.tier,
          pinnedHeadUntil: { gt: nowDate },
        },
      },
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

/**
 * The patch that drops the pin. Returned as fields rather than performed as its
 * own write so the one caller that needs it — the conversation PATCH route, when
 * Boss moves the head picker — clears the pin in the SAME update that changes
 * the model, instead of racing a second write against it.
 */
export function headPinClearFields(): Record<string, null> {
  return { pinnedHeadModel: null, pinnedHeadTier: null, pinnedHeadVia: null, pinnedHeadUntil: null }
}
