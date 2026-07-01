/**
 * Point 3 (Part B) — autonomous follow-up + carry-over of unfinished work.
 *
 * Like a real office manager, at the start of each day the agent:
 *   1. Carries any still-open owner/agent todos from previous days forward to today
 *      (so nothing silently rots with a stale due date).
 *   2. Proactively follows up with the owner on those carried items and waits for his
 *      confirmation — "done" closes them; otherwise the head adjusts them via tools.
 *
 * Reuses the ask→await-reply→act KV pattern (pending marker set on send; first owner reply
 * captured in core.ts). Day-shift duty todos (source='day_shift') are excluded — those
 * regenerate fresh each day and must not be carried.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { getOrCreateDayShiftConversation, appendShiftNarrative } from '@/agent/lib/day-shift'

const BUSINESS_ID = 'ALMA_LIFESTYLE'
const CARRY_SOURCES = ['owner', 'agent']
const OPEN_STATUSES = ['pending', 'in_progress']

function pendingKey(today: string): string {
  return `followup_pending:${today}`
}
function resolvedKey(today: string): string {
  return `followup_resolved:${today}`
}

function startOfDayDhaka(ymd: string): Date {
  return new Date(`${ymd.slice(0, 10)}T00:00:00+06:00`)
}

const DONE_PATTERN =
  /\b(done|complete|completed|finish|sesh|shesh)\b|হয়ে\s*গে|হয়েছে|শেষ\s*কর|শেষ\s*হয়|করে\s*ফেলেছি|করেছি|kore\s*felechi|kore\s*fele?chi|hoye\s*ge|hoyeche|sob\s*hoyeche|sob\s*sesh/i

const DEFER_PATTERN =
  /\b(later|pore|kal|tomorrow|aj\s*na|ajke\s*na|thak)\b|পরে|কাল\s*কর|আজ\s*না|থাক|রেখে\s*দা|rekhe\s*da/i

type CarryTodo = { id: string; title: string; dueDate: Date | null }

/** Open owner/agent todos whose due date is before today (stale, need carrying). */
export async function findIncompleteCarryTodos(today = todayYmdDhaka()): Promise<CarryTodo[]> {
  const rows = await prisma.agentTodo.findMany({
    where: {
      businessId: BUSINESS_ID,
      source: { in: CARRY_SOURCES },
      status: { in: OPEN_STATUSES },
      dueDate: { lt: startOfDayDhaka(today) },
    },
    select: { id: true, title: true, dueDate: true },
    orderBy: { dueDate: 'asc' },
    take: 20,
  })
  return rows
}

/** Bump stale open todos forward to today. Idempotent (only touches dueDate < today). */
export async function carryOverIncompleteTodos(today = todayYmdDhaka()): Promise<CarryTodo[]> {
  const carried = await findIncompleteCarryTodos(today)
  if (carried.length === 0) return []
  await prisma.agentTodo.updateMany({
    where: { id: { in: carried.map((t) => t.id) } },
    data: { dueDate: startOfDayDhaka(today) },
  })
  return carried
}

function composeFollowupMessage(carried: CarryTodo[]): string {
  const lines = carried.map((t) => `• ${t.title}`).join('\n')
  return (
    `📋 Sir, আগের দিনের ${carried.length}টি কাজ এখনো শেষ হয়নি — আজকের জন্য টেনে আনলাম:\n${lines}\n\n` +
    `এগুলোর কী অবস্থা? হয়ে গেলে বলুন "হয়ে গেছে", আর কিছু বদলাতে চাইলে বলে দিন — আমি ঠিক করে দিচ্ছি।`
  )
}

export async function isFollowupResolvedToday(today = todayYmdDhaka()): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: resolvedKey(today) }, select: { value: true } })
  return Boolean(row?.value)
}

export async function isFollowupPendingToday(today = todayYmdDhaka()): Promise<boolean> {
  if (await isFollowupResolvedToday(today)) return false
  const row = await prisma.agentKvSetting.findUnique({ where: { key: pendingKey(today) }, select: { value: true } })
  return Boolean(row?.value)
}

async function markResolved(today: string, reason: string): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: resolvedKey(today) },
    create: { key: resolvedKey(today), value: reason },
    update: { value: reason },
  })
  await prisma.agentKvSetting.deleteMany({ where: { key: pendingKey(today) } })
}

/**
 * Day-start routine: carry stale todos forward, then ask the owner about them.
 * No carried todos → silent (no message). Idempotent per day.
 */
export async function runDailyFollowupSend(): Promise<{ ok: boolean; asked: boolean; detail: string }> {
  const today = todayYmdDhaka()
  if (await isFollowupResolvedToday(today)) return { ok: true, asked: false, detail: 'already_resolved' }
  if (await isFollowupPendingToday(today)) return { ok: true, asked: false, detail: 'already_pending' }

  const carried = await carryOverIncompleteTodos(today)
  if (carried.length === 0) return { ok: true, asked: false, detail: 'nothing_pending' }

  const message = composeFollowupMessage(carried)
  const conversationId = await getOrCreateDayShiftConversation(today)
  await appendShiftNarrative(conversationId, message)
  void sendOwnerText(message).catch(() => {})

  await prisma.agentKvSetting.upsert({
    where: { key: pendingKey(today) },
    create: {
      key: pendingKey(today),
      value: JSON.stringify({
        ids: carried.map((t) => t.id),
        titles: carried.map((t) => t.title),
        sentAt: new Date().toISOString(),
      }),
    },
    update: {
      value: JSON.stringify({
        ids: carried.map((t) => t.id),
        titles: carried.map((t) => t.title),
        sentAt: new Date().toISOString(),
      }),
    },
  })

  return { ok: true, asked: true, detail: `asked_${carried.length}` }
}

export type FollowupReplyResult = { autoReply?: string; contextBlock?: string }

/** Capture the owner's reply to the carried-todo follow-up question. */
export async function processOwnerFollowupReply(
  text: string,
  _conversationId?: string,
): Promise<FollowupReplyResult | null> {
  const today = todayYmdDhaka()
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!(await isFollowupPendingToday(today))) return null

  const row = await prisma.agentKvSetting.findUnique({ where: { key: pendingKey(today) }, select: { value: true } })
  let ids: string[] = []
  let titles: string[] = []
  try {
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { ids?: string[]; titles?: string[] }
      ids = parsed.ids ?? []
      titles = parsed.titles ?? []
    }
  } catch {
    /* fall through */
  }

  // Auto-close ALL carried todos only on a SHORT, unambiguous "done" reply
  // ("হয়ে গেছে", "sob shesh"). A longer message merely CONTAINING a done-word
  // (e.g. "kalke 5ta order hoyeche, ar X ta baki") used to bulk-complete the
  // owner's whole carried list — his todos silently vanished. Anything longer
  // falls through to the head, which updates each item individually via tools.
  const isShortDoneReply = trimmed.length <= 40 && DONE_PATTERN.test(trimmed)
  if (isShortDoneReply && ids.length > 0) {
    await prisma.agentTodo.updateMany({
      where: { id: { in: ids }, status: { in: OPEN_STATUSES } },
      data: { status: 'completed', completedAt: new Date() },
    })
    await markResolved(today, 'done')
    return { autoReply: `আলহামদুলিল্লাহ Sir, ${ids.length}টি কাজ শেষ হিসেবে বন্ধ করে দিলাম। 🤝` }
  }

  if (DEFER_PATTERN.test(trimmed)) {
    await markResolved(today, 'deferred')
    return { autoReply: 'ঠিক আছে Sir, কাজগুলো আজকের তালিকায় রেখে দিলাম — পরে দেখা যাবে।' }
  }

  // Mixed / specific instructions → let the head adjust each item via tools.
  await markResolved(today, 'handed_to_head')
  return {
    contextBlock:
      `[FOLLOW-UP — CARRIED TODOS ACTIVE]\n` +
      `Sir was asked about ${ids.length} unfinished task(s) carried into today: ${titles.join(' · ')}. ` +
      `Parse his reply and update each item with manage_work_todos: action=complete for done ones, ` +
      `action=update (status/priority) or action=remove as he says. If he asks to be reminded at a time, ` +
      `use set_reminder. Reply in Bangla, concise, confirm what you changed. Do NOT re-list everything.`,
  }
}
