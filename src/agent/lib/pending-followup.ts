/**
 * Part 2 — unified autonomous follow-up ("nag until confirmed") engine.
 *
 * Like a real office manager, the agent chases EVERY item still waiting on the owner's
 * yes/no. All approval gates already land in one table — `agent_pending_actions`
 * (status='pending'): staff-task dispatch, duty approval blocks, ads-optimizer batches,
 * finance/oxylabs gates, etc. That single table is the unified "pending / not-yet-approved"
 * source the owner asked us to chase.
 *
 * Behaviour:
 *   • During office hours the day-shift tick calls runPendingFollowupTick(). Every
 *     ~2h (owner-tunable via KV `pending_nag_interval_min`) it re-sends ONE consolidated
 *     reminder listing everything still pending — repeating until the owner confirms and
 *     the items clear.
 *   • A brand-new pending item is surfaced promptly (short floor) instead of waiting a
 *     full interval.
 *   • At day start, runPendingFollowupDayStart() surfaces anything carried over from a
 *     PREVIOUS day FIRST, asking the owner to confirm before the agent moves on.
 *
 * Idempotent + spam-safe via KV `pending_nag:<ymd>` (lastNagAt + fingerprint of the
 * pending set). Self-contained; callers wrap in try/catch so it never breaks the duty flow.
 *
 * Scope note: the owner's own slow-burn to-dos (`agent_owner_todos`) keep their existing
 * nudgeAfterDays cadence, and carried day-todos (`agent_todos`) keep their day-start ask
 * in followup-carryover.ts — this engine deliberately owns the *blocking approval* set so
 * the two systems never double-nag the same thing.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { getOrCreateDayShiftConversation, appendShiftNarrative } from '@/agent/lib/day-shift'

const DEFAULT_INTERVAL_MIN = 120 // owner wants every 1–2h; default to the calmer end
const MIN_INTERVAL_MIN = 30
const MAX_INTERVAL_MIN = 360
/** Don't re-nag more often than this even when the pending set changes. */
const NEW_ITEM_FLOOR_MS = 25 * 60 * 1000
/** Only chase items created within this window (today + carried from yesterday). */
const MAX_AGE_MS = 48 * 60 * 60 * 1000

type PendingItem = { id: string; label: string; createdAt: Date }
type NagState = { lastNagAt: string; fingerprint: string; count: number }

function nagKey(today: string): string {
  return `pending_nag:${today}`
}

function startOfDayDhaka(ymd: string): Date {
  return new Date(`${ymd.slice(0, 10)}T00:00:00+06:00`)
}

function prettyType(type: string): string {
  switch (type) {
    case 'dispatch_staff_tasks':
      return 'স্টাফদের আজকের কাজ পাঠানোর approval'
    case 'duty_approval_block':
      return 'একটি duty-এর approval'
    case 'ads_optimizer_batch':
      return 'বিজ্ঞাপন optimize approval'
    default:
      return type.replace(/_/g, ' ')
  }
}

/** Every approval/dispatch gate still awaiting the owner, newest-relevant first. */
export async function collectPendingItems(): Promise<PendingItem[]> {
  const since = new Date(Date.now() - MAX_AGE_MS)
  const rows = await prisma.agentPendingAction.findMany({
    where: { status: 'pending', createdAt: { gte: since } },
    select: { id: true, summary: true, type: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 25,
  })
  return rows.map((r) => ({
    id: r.id,
    label: (r.summary || '').trim() || prettyType(r.type),
    createdAt: r.createdAt,
  }))
}

function fingerprintOf(items: PendingItem[]): string {
  return items
    .map((i) => i.id)
    .sort()
    .join(',')
}

async function getNagIntervalMs(): Promise<number> {
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: 'pending_nag_interval_min' },
    select: { value: true },
  })
  const parsed = Number(row?.value)
  const min = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MIN
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, min)) * 60 * 1000
}

async function loadNagState(today: string): Promise<NagState | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: nagKey(today) }, select: { value: true } })
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as NagState
    if (!parsed.lastNagAt) return null
    return parsed
  } catch {
    return null
  }
}

async function saveNagState(today: string, state: NagState): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: nagKey(today) },
    create: { key: nagKey(today), value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  })
}

async function clearNagState(today: string): Promise<void> {
  await prisma.agentKvSetting.deleteMany({ where: { key: nagKey(today) } })
}

function shouldNag(items: PendingItem[], state: NagState | null, intervalMs: number, now: number): boolean {
  if (!state) return true // first pending item today
  const since = now - new Date(state.lastNagAt).getTime()
  if (fingerprintOf(items) !== state.fingerprint) {
    // The pending set changed (new item appeared) — surface promptly, but not spammily.
    return since >= NEW_ITEM_FLOOR_MS
  }
  return since >= intervalMs
}

function ageHours(createdAt: Date, now: number): number {
  return Math.max(1, Math.round((now - createdAt.getTime()) / 3_600_000))
}

function composeMessage(items: PendingItem[], now: number, intervalMs: number, morning: boolean): string {
  const lines = items.map((i) => `• ${i.label} — ${ageHours(i.createdAt, now)} ঘণ্টা ধরে অপেক্ষায়`).join('\n')
  const intervalHr = Math.round(intervalMs / 3_600_000) || 2
  if (morning) {
    return (
      `🌅 শুভ সকাল Sir। গতকাল থেকে ${items.length}টি বিষয় এখনো আপনার confirm-এর অপেক্ষায় — ` +
      `আজ অন্য কাজ শুরু করার আগে এগুলো একটু দেখে নিই:\n${lines}\n\n` +
      `"approve/হ্যাঁ" বললে এগিয়ে নিই, বা বদলাতে চাইলে বলে দিন — সেভাবেই করি।`
    )
  }
  return (
    `⏳ Sir, এখনো আপনার সিদ্ধান্তের অপেক্ষায় ${items.length}টি বিষয় (approve করলে এগিয়ে নিতে পারি):\n${lines}\n\n` +
    `ঠিক থাকলে "approve/হ্যাঁ" বলুন, বদলাতে চাইলে বলে দিন। (প্রতি ${intervalHr} ঘণ্টায় মনে করিয়ে দিচ্ছি যতক্ষণ না হয়।)`
  )
}

/**
 * Office-hours tick: re-nag the owner about everything still pending, on a ~2h cadence.
 * No pending items → clears state silently. Idempotent within the interval.
 */
export async function runPendingFollowupTick(): Promise<{ nagged: boolean; count: number; detail: string }> {
  const today = todayYmdDhaka()
  const items = await collectPendingItems()
  if (items.length === 0) {
    await clearNagState(today)
    return { nagged: false, count: 0, detail: 'nothing_pending' }
  }

  const intervalMs = await getNagIntervalMs()
  const state = await loadNagState(today)
  const now = Date.now()
  if (!shouldNag(items, state, intervalMs, now)) {
    return { nagged: false, count: items.length, detail: 'within_interval' }
  }

  const message = composeMessage(items, now, intervalMs, false)
  const conversationId = await getOrCreateDayShiftConversation(today)
  await appendShiftNarrative(conversationId, message)
  void sendOwnerText(message).catch(() => {})

  await saveNagState(today, {
    lastNagAt: new Date(now).toISOString(),
    fingerprint: fingerprintOf(items),
    count: (state?.count ?? 0) + 1,
  })
  return { nagged: true, count: items.length, detail: `nagged_${items.length}` }
}

/**
 * Day-start: if anything is still pending from a PREVIOUS day, ask the owner to confirm
 * FIRST (before the agent runs the day's duties). Resets the nag clock so the tick won't
 * immediately re-nag the same set.
 */
export async function runPendingFollowupDayStart(): Promise<{ asked: boolean; count: number }> {
  const today = todayYmdDhaka()
  const cutoff = startOfDayDhaka(today)
  const all = await collectPendingItems()
  const carried = all.filter((i) => i.createdAt < cutoff)
  if (carried.length === 0) return { asked: false, count: 0 }

  const intervalMs = await getNagIntervalMs()
  const message = composeMessage(carried, Date.now(), intervalMs, true)
  const conversationId = await getOrCreateDayShiftConversation(today)
  await appendShiftNarrative(conversationId, message)
  void sendOwnerText(message).catch(() => {})

  // Seed the nag clock against the FULL current set so the tick paces from here.
  await saveNagState(today, {
    lastNagAt: new Date().toISOString(),
    fingerprint: fingerprintOf(all),
    count: 1,
  })
  return { asked: true, count: carried.length }
}
