/**
 * Phase D — evening owner-task intake (Sir-tasks for tomorrow) + respectful no-task streak.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { PERSONAL_ADVISOR_PROMPT } from '@/agent/lib/personal-prompt'
import { getOrCreateDayShiftConversation, appendShiftNarrative } from '@/agent/lib/day-shift'

const BUSINESS_ID = 'ALMA_LIFESTYLE'

const INTAKE_MESSAGE =
  '🌙 Sir, কালকের জন্য আপনার কোন কাজগুলো রাখবো? বলে দিন, আমি যোগ করে রাখি।'

const NUDGE_MESSAGE =
  'Sir, ২ দিন ধরে আপনি নিজের জন্য কোনো কাজ রাখছেন না। ব্যবসাটা দাঁড় করাতে আরেকটু পরিশ্রম দরকার — ' +
  'নাকি অন্য কিছু নিয়ে চিন্তায় আছেন? বলতে পারেন, আমি আছি।'

const NO_TASK_ACCEPT = 'ঠিক আছে Sir, কালকের জন্য কিছু রাখছি না।'

const NO_TASK_PATTERN =
  /\b(kichu\s*korbo\s*na|kichu\s*rakhbo\s*na|kalk\s*kichu\s*na|kalke\s*kichu\s*na|nothing|no\s*tasks?)\b|কিছু\s*করব\s*না|কিছু\s*রাখব\s*না|কাল\s*কিছু\s*না|আজ\s*থাক|থাক\s*$|না\s*রাখ|রাখব\s*না/i

const PROBLEM_PATTERN =
  /\b(stress|depressed|problem|somossa|chinta|tension|parbo\s*na|korte\s*parbo\s*na)\b|চিন্ত|সমস্য|টেনশন|হতাশ|কষ্ট|মন\s*খার|আর\s*হচ্ছ\s*না|পারছি\s*না/i

export type OwnerIntakeReplyResult = {
  autoReply?: string
  contextBlock?: string
  forcePersonalMode?: boolean
  tasksAdded?: string[]
}

function noTaskKey(ymd: string): string {
  return `owner_no_task:${ymd}`
}

function intakePendingKey(todayYmd: string): string {
  return `owner_intake_pending:${todayYmd}`
}

function intakeResolvedKey(todayYmd: string): string {
  return `owner_intake_resolved:${todayYmd}`
}

function dueDateRangeDhaka(ymd: string): { start: Date; end: Date } {
  const day = ymd.slice(0, 10)
  return {
    start: new Date(`${day}T00:00:00+06:00`),
    end: new Date(`${day}T23:59:59.999+06:00`),
  }
}

export function tomorrowYmdDhaka(fromYmd = todayYmdDhaka()): string {
  const d = new Date(`${fromYmd.slice(0, 10)}T12:00:00+06:00`)
  d.setDate(d.getDate() + 1)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function addDaysYmd(ymd: string, delta: number): string {
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00+06:00`)
  d.setDate(d.getDate() + delta)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

async function hasNoTaskMarker(ymd: string): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: noTaskKey(ymd) },
    select: { value: true },
  })
  return row?.value === 'true' || row?.value === '"true"'
}

export async function countOwnerTodosDue(ymd: string): Promise<number> {
  const { start, end } = dueDateRangeDhaka(ymd)
  return prisma.agentTodo.count({
    where: {
      businessId: BUSINESS_ID,
      source: 'owner',
      dueDate: { gte: start, lte: end },
      status: { notIn: ['cancelled'] },
    },
  })
}

/** Day had zero owner todos (or explicit no_task marker). */
export async function isOwnerNoTaskDay(ymd: string): Promise<boolean> {
  if (await hasNoTaskMarker(ymd)) return true
  return (await countOwnerTodosDue(ymd)) === 0
}

/** Consecutive past days (today backward) with no owner tasks. */
export async function countConsecutiveNoTaskDays(asOfYmd = todayYmdDhaka()): Promise<number> {
  let streak = 0
  for (let i = 0; i < 14; i++) {
    const d = addDaysYmd(asOfYmd, -i)
    if (await isOwnerNoTaskDay(d)) streak++
    else break
  }
  return streak
}

export async function recordNoTaskDay(targetYmd: string): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: noTaskKey(targetYmd) },
    create: { key: noTaskKey(targetYmd), value: 'true' },
    update: { value: 'true' },
  })
}

async function markIntakeResolved(todayYmd: string, reason: string): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: intakeResolvedKey(todayYmd) },
    create: { key: intakeResolvedKey(todayYmd), value: reason },
    update: { value: reason },
  })
  await prisma.agentKvSetting.deleteMany({ where: { key: intakePendingKey(todayYmd) } })
}

export async function isIntakeResolvedToday(todayYmd = todayYmdDhaka()): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: intakeResolvedKey(todayYmd) },
    select: { value: true },
  })
  return Boolean(row?.value)
}

export async function isIntakePendingToday(todayYmd = todayYmdDhaka()): Promise<boolean> {
  if (await isIntakeResolvedToday(todayYmd)) return false
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: intakePendingKey(todayYmd) },
    select: { value: true },
  })
  return Boolean(row?.value)
}

function extractTaskTitles(text: string): string[] {
  const raw = text.trim()
  if (!raw || NO_TASK_PATTERN.test(raw)) return []

  const parts = raw
    .split(/\n+|(?:\d+[\.)]\s*)|(?:[,;]\s*)/)
    .map((s) => s.trim().replace(/^[-•*]\s*/, ''))
    .filter((s) => s.length >= 3 && s.length <= 200)
    .filter((s) => !NO_TASK_PATTERN.test(s))
    .filter((s) => !/^(hi|hello|salam|asalam|ok|thanks|thank you|ha|haan|na)$/i.test(s))

  return [...new Set(parts)].slice(0, 12)
}

export async function addOwnerTodosForDate(titles: string[], dueYmd: string): Promise<string[]> {
  const { start } = dueDateRangeDhaka(dueYmd)
  const created: string[] = []

  for (const title of titles) {
    const existing = await prisma.agentTodo.findFirst({
      where: {
        businessId: BUSINESS_ID,
        source: 'owner',
        title: { equals: title, mode: 'insensitive' },
        dueDate: { gte: dueDateRangeDhaka(dueYmd).start, lte: dueDateRangeDhaka(dueYmd).end },
        status: { notIn: ['cancelled'] },
      },
    })
    if (existing) continue

    await prisma.agentTodo.create({
      data: {
        title,
        source: 'owner',
        businessId: BUSINESS_ID,
        dueDate: start,
        priority: 'normal',
        status: 'pending',
      },
    })
    created.push(title)
  }

  if (created.length > 0) {
    await prisma.agentKvSetting.deleteMany({
      where: { key: noTaskKey(dueYmd) },
    })
  }

  return created
}

export async function composeOwnerTaskIntakeMessage(todayYmd = todayYmdDhaka()): Promise<{
  message: string
  streak: number
  tomorrow: string
}> {
  const streak = await countConsecutiveNoTaskDays(todayYmd)
  const tomorrow = tomorrowYmdDhaka(todayYmd)

  if (streak >= 2) {
    return {
      message: `${NUDGE_MESSAGE}\n\n${INTAKE_MESSAGE}`,
      streak,
      tomorrow,
    }
  }

  return { message: INTAKE_MESSAGE, streak, tomorrow }
}

/** Send intake to office chat + Telegram; mark pending for owner reply. */
export async function runOwnerTaskIntakeSend(): Promise<{ ok: boolean; message: string; streak: number }> {
  const today = todayYmdDhaka()
  if (await isIntakeResolvedToday(today)) {
    return { ok: true, message: 'already_resolved', streak: 0 }
  }

  const { message, streak, tomorrow } = await composeOwnerTaskIntakeMessage(today)
  const conversationId = await getOrCreateDayShiftConversation(today)

  await appendShiftNarrative(conversationId, message)
  void sendOwnerText(message).catch(() => {})

  await prisma.agentKvSetting.upsert({
    where: { key: intakePendingKey(today) },
    create: {
      key: intakePendingKey(today),
      value: JSON.stringify({ tomorrow, sentAt: new Date().toISOString(), streak }),
    },
    update: {
      value: JSON.stringify({ tomorrow, sentAt: new Date().toISOString(), streak }),
    },
  })

  return { ok: true, message, streak }
}

/** Process owner reply during intake window (same evening, after 8pm Dhaka). */
export async function processOwnerIntakeReply(
  text: string,
  _conversationId?: string,
): Promise<OwnerIntakeReplyResult | null> {
  const today = todayYmdDhaka()
  const trimmed = text.trim()
  if (!trimmed) return null

  const pending = await isIntakePendingToday(today)
  if (!pending) return null

  const pendingRow = await prisma.agentKvSetting.findUnique({
    where: { key: intakePendingKey(today) },
    select: { value: true },
  })
  let tomorrow = tomorrowYmdDhaka(today)
  try {
    if (pendingRow?.value) {
      const parsed = JSON.parse(pendingRow.value) as { tomorrow?: string }
      if (parsed.tomorrow) tomorrow = parsed.tomorrow.slice(0, 10)
    }
  } catch {
    /* use default tomorrow */
  }

  if (NO_TASK_PATTERN.test(trimmed)) {
    await recordNoTaskDay(tomorrow)
    await markIntakeResolved(today, 'no_task')
    return { autoReply: NO_TASK_ACCEPT }
  }

  const streak = await countConsecutiveNoTaskDays(today)
  if (streak >= 2 && PROBLEM_PATTERN.test(trimmed)) {
    await markIntakeResolved(today, 'advisor')
    return {
      forcePersonalMode: true,
      contextBlock:
        `${PERSONAL_ADVISOR_PROMPT}\n\n` +
        `[OWNER TASK INTAKE — ADVISOR MODE]\n` +
        `Sir shared a personal/struggle signal after ${streak} days without self-tasks. Listen first, then practical + gentle Islamic encouragement. ` +
        `Do NOT guilt-trip or mention slacking. Do NOT pull business/staff data unless he asks.`,
    }
  }

  const titles = extractTaskTitles(trimmed)
  if (titles.length > 0) {
    const created = await addOwnerTodosForDate(titles, tomorrow)
    await markIntakeResolved(today, 'tasks_added')
    const list = created.length > 0 ? created.join(' · ') : titles.join(' · ')
    return {
      autoReply:
        created.length > 0
          ? `ঠিক আছে Sir, কালকের জন্য ${created.length}টি কাজ রেখে দিয়েছি: ${list}।`
          : `Sir, ওই কাজগুলো ইতিমধ্যে তালিকায় আছে।`,
      tasksAdded: created.length > 0 ? created : titles,
    }
  }

  return {
    contextBlock:
      `[OWNER TASK INTAKE — ACTIVE]\n` +
      `Sir was asked for tomorrow's personal tasks (${tomorrow}). Parse his message into 1+ concrete tasks. ` +
      `Use manage_work_todos action=add, source=owner, dueDate=${tomorrow} for each task (intake only — do NOT auto-complete). ` +
      `If he declines ("কিছু করব না"), accept warmly and stop. One gentle line max if unclear.`,
  }
}
