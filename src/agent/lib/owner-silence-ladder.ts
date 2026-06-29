/**
 * Feature B — Owner-silence escalation ladder ("critical জিনিস হারিয়ে যাবে না").
 *
 * The existing pending-followup engine (pending-followup.ts) chases every approval
 * still waiting on the owner — but it re-sends the SAME gentle Telegram nudge no
 * matter how long an item has been ignored. A genuinely critical approval left
 * unacknowledged for hours gets the exact same soft ping as a 25-minute-old one,
 * so it can quietly get lost.
 *
 * This module adds the missing piece: a CHANNEL-escalation ladder driven by how
 * long the OLDEST pending item has been waiting. The longer the silence, the
 * louder the channel:
 *
 *   L0  < L1_MIN            — nothing extra (pending-followup's Telegram nudge handles it).
 *   L1  ≥ L1_MIN            — also fire a LOUD ntfy-critical (priority-5) push, so it
 *                             cuts through; "don't let it get lost."
 *   L2  ≥ L2_MIN + critical — an unmistakable tier-3 critical alert, flagged
 *                             call-worthy, for money/finance-class approvals only.
 *
 * Safety — this NEVER acts on the pending item itself:
 *   • It only NOTIFIES harder; it never approves, dispatches, dials, or moves money.
 *   • Idempotent: it escalates at most ONCE per level per unchanged pending-set
 *     (KV `silence_ladder:<ymd>`), so it can't spam tick after tick.
 *   • When the pending set clears, the ladder resets to L0.
 *   • Bounded to office hours by its caller (tickDayShift), like every other nudge.
 *
 * No DB migration — the ladder state lives in agent_kv_settings, the same KV
 * pattern pending-followup and the signal scanner use.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { collectPendingItems } from '@/agent/lib/pending-followup'
import { notifyOwner } from '@/agent/lib/notify-owner'

/** Silence (minutes) before the loud ntfy-critical push (L1). */
export const LADDER_L1_MIN = 90
/** Silence (minutes) before the unmistakable call-worthy alert (L2). */
export const LADDER_L2_MIN = 180

/**
 * Approval types that count as CRITICAL — money / finance / paid-action gates that
 * must not be lost. Only these reach L2 (the call-worthy tier); everything else
 * tops out at L1's loud push.
 */
export const CRITICAL_PENDING_TYPES = new Set<string>([
  'finance_approval',
  'oxylabs_approval',
  'ads_optimizer_batch',
])
/** Any item ignored this long is treated as critical regardless of type. */
const CRITICAL_AGE_MIN = 240

const LADDER_KEY_PREFIX = 'silence_ladder:'

export type LadderLevel = 0 | 1 | 2

/** Minimal shape the pure calculator needs from a pending item. */
export interface PendingLike {
  type: string
  createdAt: Date
  summary?: string
}

export interface SilenceEscalation {
  level: LadderLevel
  /** Owner-facing Bangla label for the level. */
  levelLabel: string
  /** Age of the oldest pending item, in minutes. */
  oldestAgeMin: number
  /** True when a money/finance-class (or very old) item is in the set. */
  hasCritical: boolean
  /** The extra channel this level fires beyond the normal Telegram nudge. */
  channel: 'none' | 'ntfy_critical' | 'critical_alert'
  /** True at L2 — a phone call to the owner is warranted (loud alert says so). */
  callWarranted: boolean
}

function ageMin(createdAt: Date, now: number): number {
  return Math.max(0, Math.floor((now - createdAt.getTime()) / 60_000))
}

function isCritical(item: PendingLike, now: number): boolean {
  if (CRITICAL_PENDING_TYPES.has(item.type)) return true
  if (ageMin(item.createdAt, now) >= CRITICAL_AGE_MIN) return true
  const s = (item.summary ?? '').toLowerCase()
  // Money cues in the summary (BDT sign, "taka", payment/refund) → treat as critical.
  return /৳|টাকা|payment|পেমেন্ট|refund|রিফান্ড|tk\b/.test(s)
}

/**
 * PURE, deterministic — no IO — so it is fully unit-testable. Given the current
 * pending set and `now`, decide which rung of the ladder we are on.
 */
export function computeSilenceEscalation(items: PendingLike[], now: number): SilenceEscalation {
  if (items.length === 0) {
    return {
      level: 0,
      levelLabel: 'কিছু pending নেই',
      oldestAgeMin: 0,
      hasCritical: false,
      channel: 'none',
      callWarranted: false,
    }
  }

  const oldestAgeMin = Math.max(...items.map((i) => ageMin(i.createdAt, now)))
  const hasCritical = items.some((i) => isCritical(i, now))

  if (oldestAgeMin >= LADDER_L2_MIN && hasCritical) {
    return {
      level: 2,
      levelLabel: 'L2 — জরুরি, কল করার মতো',
      oldestAgeMin,
      hasCritical,
      channel: 'critical_alert',
      callWarranted: true,
    }
  }
  if (oldestAgeMin >= LADDER_L1_MIN) {
    return {
      level: 1,
      levelLabel: 'L1 — জোরে alert',
      oldestAgeMin,
      hasCritical,
      channel: 'ntfy_critical',
      callWarranted: false,
    }
  }
  return {
    level: 0,
    levelLabel: 'L0 — স্বাভাবিক reminder',
    oldestAgeMin,
    hasCritical,
    channel: 'none',
    callWarranted: false,
  }
}

interface LadderState {
  level: LadderLevel
  firedAt: string
  fingerprint: string
}

function ladderKey(today: string): string {
  return `${LADDER_KEY_PREFIX}${today}`
}

function fingerprintOf(items: PendingLike[]): string {
  return items
    .map((i) => `${i.type}@${i.createdAt.getTime()}`)
    .sort()
    .join(',')
}

async function loadLadderState(today: string): Promise<LadderState | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: ladderKey(today) }, select: { value: true } })
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as LadderState
    return typeof parsed.level === 'number' ? parsed : null
  } catch {
    return null
  }
}

async function saveLadderState(today: string, state: LadderState): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: ladderKey(today) },
    create: { key: ladderKey(today), value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  })
}

async function clearLadderState(today: string): Promise<void> {
  await prisma.agentKvSetting.deleteMany({ where: { key: ladderKey(today) } })
}

function composeAlert(esc: SilenceEscalation, count: number): { title: string; message: string } {
  const hrs = Math.max(1, Math.round(esc.oldestAgeMin / 60))
  if (esc.level === 2) {
    return {
      title: '🚨 জরুরি — সিদ্ধান্ত আটকে আছে',
      message:
        `Sir, ${count}টি approval এখনো আটকে — সবচেয়ে পুরোনোটা ${hrs} ঘণ্টা ধরে অপেক্ষায়, ` +
        `আর এর মধ্যে money/critical একটা আছে। এটা হারিয়ে যাওয়ার আগে এখনই একটু দেখুন — ` +
        `দরকার হলে ফোনেও জানাতে পারি। "approve/হ্যাঁ" বললে এগিয়ে নিই।`,
    }
  }
  return {
    title: '⏳ এখনো আপনার সিদ্ধান্তের অপেক্ষায়',
    message:
      `Sir, ${count}টি বিষয় ${hrs} ঘণ্টা ধরে আপনার confirm-এর অপেক্ষায় আছে — যেন হারিয়ে না যায় তাই ` +
      `জোরে মনে করালাম। "approve/হ্যাঁ" বললে এগিয়ে নিই, ব্যস্ত থাকলে "পরে" বলুন।`,
  }
}

export interface LadderRunResult {
  level: LadderLevel
  escalated: boolean
  count: number
  oldestAgeMin: number
  detail: string
}

/**
 * Run the silence ladder once. Reads the unified pending-approval set, computes the
 * current rung, and — only when the rung has RISEN since we last fired for this same
 * set — pushes the louder channel. Idempotent and spam-safe. Never throws beyond what
 * the caller wraps; designed to slot in right after runPendingFollowupTick().
 */
export async function runOwnerSilenceLadder(opts: { now?: Date } = {}): Promise<LadderRunResult> {
  const now = (opts.now ?? new Date()).getTime()
  const today = todayYmdDhaka()
  const items = await collectPendingItems()

  if (items.length === 0) {
    await clearLadderState(today)
    return { level: 0, escalated: false, count: 0, oldestAgeMin: 0, detail: 'nothing_pending' }
  }

  const esc = computeSilenceEscalation(items, now)
  const fingerprint = fingerprintOf(items)
  const prev = await loadLadderState(today)

  // Escalate only when we climb to a higher rung than we last fired for THIS set.
  // (A changed pending-set resets the comparison so a brand-new critical item can
  // re-trigger, but the same set never escalates twice at the same level.)
  const sameSet = prev?.fingerprint === fingerprint
  const lastLevel = sameSet ? (prev?.level ?? 0) : 0
  if (esc.level <= lastLevel || esc.level === 0) {
    return { level: esc.level, escalated: false, count: items.length, oldestAgeMin: esc.oldestAgeMin, detail: `steady_L${esc.level}` }
  }

  const { title, message } = composeAlert(esc, items.length)
  // L1 → tier 2 (ntfy critical). L2 → tier 3 (loudest, call-worthy).
  await notifyOwner({ tier: esc.level >= 2 ? 3 : 2, title, message, category: 'urgent' }).catch(() => {})

  await saveLadderState(today, { level: esc.level, firedAt: new Date(now).toISOString(), fingerprint })
  return { level: esc.level, escalated: true, count: items.length, oldestAgeMin: esc.oldestAgeMin, detail: `escalated_L${esc.level}` }
}
