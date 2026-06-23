/**
 * Part 2 — unified autonomous follow-up ("chase until confirmed") engine, ADAPTIVE pace.
 *
 * Like a real office manager, the agent chases EVERY item still waiting on the owner's
 * yes/no. All approval gates land in one table — `agent_pending_actions` (status='pending'):
 * staff-task dispatch, duty approval blocks, ads-optimizer batches, finance/oxylabs gates.
 * That single table is the unified "pending / not-yet-approved" source we chase.
 *
 * The follow-up pace is NOT a flat interval — the agent decides it from the situation:
 *   1. Per-type urgency — staff dispatch (people are waiting) is chased far sooner than a
 *      calm ads tweak. The cadence follows the MOST urgent item still pending.
 *   2. Owner availability — if the owner replies "busy / driving / 30 min por / 1 ঘণ্টা পর"
 *      to a reminder, processFollowupPaceReply() snoozes the chase by exactly that long.
 *   3. Explicit override — owner can pin a fixed cadence via KV `pending_nag_interval_min`.
 *
 * Behaviour:
 *   • Office-hours tick → runPendingFollowupTick(): re-sends ONE consolidated reminder when
 *     the adaptive interval elapses (and no active snooze), repeating until items clear.
 *   • Day start → runPendingFollowupDayStart(): anything carried over from a PREVIOUS day is
 *     surfaced FIRST, before the agent runs its duties.
 *
 * Spam-safe + idempotent via KV `pending_nag:<ymd>` (lastNagAt + fingerprint of the set)
 * and `pending_nag_snooze:<ymd>` (owner-set quiet-until). Self-contained; callers wrap in
 * try/catch so it never breaks the duty flow.
 *
 * Scope note: the owner's slow-burn to-dos (`agent_owner_todos`) keep their own
 * nudgeAfterDays cadence, and carried day-todos (`agent_todos`) keep their day-start ask in
 * followup-carryover.ts — this engine owns the *blocking approval* set so the systems never
 * double-nag the same thing.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { getOrCreateDayShiftConversation, appendShiftNarrative } from '@/agent/lib/day-shift'

const DEFAULT_INTERVAL_MIN = 120 // calm fallback when nothing urgent is pending
const MIN_INTERVAL_MIN = 10
const MAX_INTERVAL_MIN = 360
/** Don't re-nag more often than this even when the pending set changes. */
const NEW_ITEM_FLOOR_MS = 20 * 60 * 1000
/** Only chase items created within this window (today + carried from yesterday). */
const MAX_AGE_MS = 48 * 60 * 60 * 1000
/** When the owner says "busy/later" with no number, snooze this long by default. */
const DEFAULT_SNOOZE_MIN = 45
/** Only treat an owner message as a pace reply if a nag went out this recently. */
const PACE_REPLY_WINDOW_MS = 90 * 60 * 1000

type PendingItem = { id: string; type: string; label: string; createdAt: Date }
type NagState = { lastNagAt: string; fingerprint: string; count: number }

function nagKey(today: string): string {
  return `pending_nag:${today}`
}
function snoozeKey(today: string): string {
  return `pending_nag_snooze:${today}`
}

function startOfDayDhaka(ymd: string): Date {
  return new Date(`${ymd.slice(0, 10)}T00:00:00+06:00`)
}

function clampMin(m: number): number {
  return Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, m))
}

function prettyType(type: string): string {
  switch (type) {
    case 'dispatch_staff_tasks':
      return 'স্টাফদের আজকের কাজ পাঠানোর approval'
    case 'duty_approval_block':
      return 'একটি duty-এর approval'
    case 'ads_optimizer_batch':
      return 'বিজ্ঞাপন optimize approval'
    case 'coworker_request':
      return 'Claude co-worker-এর একটি অনুরোধ'
    default:
      return type.replace(/_/g, ' ')
  }
}

/** The agent's situational read of how soon each kind of approval should be chased (minutes). */
function typeIntervalMin(type: string): number {
  switch (type) {
    case 'dispatch_staff_tasks':
      return 25 // staff are waiting on their day's work — chase soon
    case 'ads_optimizer_batch':
      return 45
    case 'coworker_request':
      return 45 // co-worker proposed an action; chase the owner at a moderate pace
    case 'duty_approval_block':
      return 60
    default:
      return DEFAULT_INTERVAL_MIN
  }
}

/** Every approval/dispatch gate still awaiting the owner, oldest first. */
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
    type: r.type,
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

/** Adaptive cadence: explicit owner override wins; else follow the most urgent item. */
async function effectiveIntervalMs(items: PendingItem[]): Promise<number> {
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: 'pending_nag_interval_min' },
    select: { value: true },
  })
  const override = Number(row?.value)
  if (Number.isFinite(override) && override > 0) return clampMin(override) * 60 * 1000
  const urgentMin = items.length > 0 ? Math.min(...items.map((i) => typeIntervalMin(i.type))) : DEFAULT_INTERVAL_MIN
  return clampMin(urgentMin) * 60 * 1000
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

async function getSnoozeUntil(today: string): Promise<number | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: snoozeKey(today) }, select: { value: true } })
  if (!row?.value) return null
  const t = new Date(row.value).getTime()
  return Number.isFinite(t) ? t : null
}

async function setSnoozeUntil(today: string, until: Date): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: snoozeKey(today) },
    create: { key: snoozeKey(today), value: until.toISOString() },
    update: { value: until.toISOString() },
  })
}

function shouldNag(
  items: PendingItem[],
  state: NagState | null,
  intervalMs: number,
  snoozeUntil: number | null,
  now: number,
): boolean {
  if (snoozeUntil && now < snoozeUntil) return false // owner asked for quiet
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

function composeMessage(items: PendingItem[], now: number, morning: boolean): string {
  const lines = items.map((i) => `• ${i.label} — ${ageHours(i.createdAt, now)} ঘণ্টা ধরে অপেক্ষায়`).join('\n')
  if (morning) {
    return (
      `🌅 শুভ সকাল Sir। গতকাল থেকে ${items.length}টি বিষয় এখনো আপনার confirm-এর অপেক্ষায় — ` +
      `আজ অন্য কাজ শুরু করার আগে এগুলো একটু দেখে নিই:\n${lines}\n\n` +
      `"approve/হ্যাঁ" বললে এগিয়ে নিই, বা বদলাতে চাইলে বলে দিন — সেভাবেই করি।`
    )
  }
  return (
    `⏳ Sir, এখনো আপনার সিদ্ধান্তের অপেক্ষায় ${items.length}টি বিষয় (approve করলে এগিয়ে নিতে পারি):\n${lines}\n\n` +
    `ঠিক থাকলে "approve/হ্যাঁ" বলুন, বদলাতে চাইলে বলে দিন। ব্যস্ত থাকলে "পরে / ৩০ মিনিট পর" বললে তখন আবার মনে করাবো।`
  )
}

/**
 * Office-hours tick: re-nag the owner about everything still pending, on an ADAPTIVE
 * cadence (urgent items chased sooner; honours owner snooze). Clears state when nothing
 * is pending. Idempotent within the interval.
 */
export async function runPendingFollowupTick(): Promise<{ nagged: boolean; count: number; detail: string }> {
  const today = todayYmdDhaka()
  const items = await collectPendingItems()
  if (items.length === 0) {
    await clearNagState(today)
    return { nagged: false, count: 0, detail: 'nothing_pending' }
  }

  const intervalMs = await effectiveIntervalMs(items)
  const state = await loadNagState(today)
  const snoozeUntil = await getSnoozeUntil(today)
  const now = Date.now()
  if (!shouldNag(items, state, intervalMs, snoozeUntil, now)) {
    return { nagged: false, count: items.length, detail: snoozeUntil && now < snoozeUntil ? 'snoozed' : 'within_interval' }
  }

  const message = composeMessage(items, now, false)
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
 * FIRST (before the agent runs the day's duties). Seeds the nag clock so the tick won't
 * immediately re-nag the same set.
 */
export async function runPendingFollowupDayStart(): Promise<{ asked: boolean; count: number }> {
  const today = todayYmdDhaka()
  const cutoff = startOfDayDhaka(today)
  const all = await collectPendingItems()
  const carried = all.filter((i) => i.createdAt < cutoff)
  if (carried.length === 0) return { asked: false, count: 0 }

  const message = composeMessage(carried, Date.now(), true)
  const conversationId = await getOrCreateDayShiftConversation(today)
  await appendShiftNarrative(conversationId, message)
  void sendOwnerText(message).catch(() => {})

  await saveNagState(today, {
    lastNagAt: new Date().toISOString(),
    fingerprint: fingerprintOf(all),
    count: 1,
  })
  return { asked: true, count: carried.length }
}

// ── Owner availability → adaptive snooze ─────────────────────────────────────

const BN_DIGITS: Record<string, string> = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' }
function asciiDigits(s: string): string {
  return s.replace(/[০-৯]/g, (d) => BN_DIGITS[d] ?? d)
}

const WORD_NUM: Record<string, number> = {
  ek: 1, dui: 2, tin: 3, char: 4, এক: 1, দুই: 2, তিন: 3, চার: 4,
}
// NOTE: \b doesn't work around Bengali (non-ASCII) characters, so we gate alternations
// with latin-letter lookarounds — equivalent to \b for ASCII, but also correct for Bangla.
const AVAILABILITY_PATTERN =
  /(?<![a-z])(busy|driving|meeting|pore|later|thak|wait)(?![a-z])|ব্যস্ত|গাড়ি|ড্রাইভ|মিটিং|পরে|থাক|একটু\s*পর|ektu\s*por/i

/** Parse a relative snooze duration from the owner's reply; null if none found. */
export function parseSnoozeMs(textRaw: string): number | null {
  const text = asciiDigits(textRaw.toLowerCase())

  // explicit minutes: "30 min", "১৫ মিনিট", "20 mint"
  const minM = text.match(/(\d+)\s*(min|mins|minute|minutes|mint|মিনিট|mn)(?![a-z])/)
  if (minM) return Math.max(5, Number(minM[1])) * 60 * 1000

  // half hour
  if (/আধা?\s*ঘণ্টা|আধ\s*ঘন্টা|half\s*(an\s*)?hour|adha\s*ghonta|adha\s*ghanta/.test(text)) return 30 * 60 * 1000

  // explicit hours (numeric): "1 ghonta", "2 hour", "১ ঘণ্টা"
  const hrM = text.match(/(\d+)\s*(ghonta|ghanta|ghn|hour|hours|hr|hrs|ঘণ্টা|ঘন্টা)(?![a-z])/)
  if (hrM) return Math.max(1, Number(hrM[1])) * 60 * 60 * 1000

  // word-number hours: "ek ghonta", "দুই ঘণ্টা"
  const wordM = text.match(/(?<![a-z])(ek|dui|tin|char|এক|দুই|তিন|চার)\s*(ghonta|ghanta|ঘণ্টা|ঘন্টা|hour)(?![a-z])/)
  if (wordM) return (WORD_NUM[wordM[1]] ?? 1) * 60 * 60 * 1000

  // availability keyword without a number → default quiet window
  if (AVAILABILITY_PATTERN.test(text)) return DEFAULT_SNOOZE_MIN * 60 * 1000

  return null
}

function humanizeMs(ms: number): string {
  const mins = Math.round(ms / 60000)
  if (mins >= 60) {
    const hrs = Math.round((mins / 60) * 10) / 10
    return `${hrs} ঘণ্টা`
  }
  return `${mins} মিনিট`
}

/**
 * Capture the owner's availability reply to a recent pending-reminder and snooze the chase
 * accordingly. Only fires when something is pending AND a reminder went out recently, so it
 * never hijacks unrelated conversation. Returns an autoReply confirming the new timing.
 */
export async function processFollowupPaceReply(
  text: string,
  _conversationId?: string,
): Promise<{ autoReply?: string } | null> {
  const trimmed = text.trim()
  if (!trimmed) return null
  const today = todayYmdDhaka()

  const items = await collectPendingItems()
  if (items.length === 0) return null
  const state = await loadNagState(today)
  if (!state) return null // we haven't nagged yet — don't interpret as a pace reply
  if (Date.now() - new Date(state.lastNagAt).getTime() > PACE_REPLY_WINDOW_MS) return null

  const ms = parseSnoozeMs(trimmed)
  if (ms == null) return null

  const until = new Date(Date.now() + ms)
  await setSnoozeUntil(today, until)
  return {
    autoReply: `ঠিক আছে Sir, ${humanizeMs(ms)} পরে আবার মনে করিয়ে দিচ্ছি — আপনি নিশ্চিন্তে কাজ সেরে নিন। 🤝`,
  }
}
