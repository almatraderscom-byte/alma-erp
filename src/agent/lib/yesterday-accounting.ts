/**
 * Point 2 — yesterday-accounting intake.
 *
 * When a new office day starts, if the previous day's MAIN office work (staff task
 * dispatch) did not happen, the agent first asks the owner the reason. When the owner
 * replies, the reason is saved to memory (so weekly reports + future context can use it),
 * an instant suggestion is given, and the day's work proceeds.
 *
 * Modeled on the existing evening `owner-task-intake.ts` ask→await-reply→act pattern:
 * a KV "pending" marker is set when the question is sent, and the first owner reply while
 * pending is captured (in core.ts) as the reason.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { getOrCreateDayShiftConversation, appendShiftNarrative } from '@/agent/lib/day-shift'
import { createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'

const BUSINESS_ID = 'ALMA_LIFESTYLE'

function pendingKey(todayYmd: string): string {
  return `office_accounting_pending:${todayYmd}`
}

function resolvedKey(todayYmd: string): string {
  return `office_accounting_resolved:${todayYmd}`
}

/** Reason for a missed office day — also written by Point 3 when owner declares no-office. */
export function missReasonKey(missedYmd: string): string {
  return `office_miss_reason:${missedYmd}`
}

/** Point 3 forward-compat: owner-declared "no office today" suppresses the accounting ask. */
function officeOffKey(ymd: string): string {
  return `office_off:${ymd}`
}

function dueDateRangeDhaka(ymd: string): { start: Date; end: Date } {
  const day = ymd.slice(0, 10)
  return {
    start: new Date(`${day}T00:00:00+06:00`),
    end: new Date(`${day}T23:59:59.999+06:00`),
  }
}

export function yesterdayYmdDhaka(fromYmd = todayYmdDhaka()): string {
  return addDaysYmd(fromYmd, -1)
}

function addDaysYmd(ymd: string, delta: number): string {
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00+06:00`)
  d.setDate(d.getDate() + delta)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

async function hasKv(key: string): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
  return Boolean(row?.value)
}

/** True if staff tasks for the date actually reached staff (dispatch happened). */
export async function wasDispatchDoneForDate(ymd: string): Promise<boolean> {
  const { start, end } = dueDateRangeDhaka(ymd)
  const sent = await prisma.agentStaffTask.count({
    where: {
      proposedFor: { gte: start, lte: end },
      status: { in: ['sent', 'done', 'completed'] },
    },
  })
  return sent > 0
}

export async function isAccountingPendingToday(todayYmd = todayYmdDhaka()): Promise<boolean> {
  if (await hasKv(resolvedKey(todayYmd))) return false
  return hasKv(pendingKey(todayYmd))
}

function composeAccountingQuestion(yesterdayYmd: string): string {
  return (
    `🗓️ Boss, নতুন দিন শুরু করার আগে একটা হিসাব নিই — গতকাল (${yesterdayYmd}) অফিসের মূল কাজটা ` +
    `(স্টাফ টাস্ক dispatch) হয়নি মনে হচ্ছে। কারণটা একটু বলবেন? ` +
    `আপনি জানালে আমি মনে রাখবো, একটা পরামর্শ দেবো, তারপর আজকের কাজ শুরু করি।`
  )
}

/**
 * Called at day start. If yesterday's dispatch did not happen (and owner hasn't already
 * been asked / hasn't declared no-office), send the accounting question and mark pending.
 */
export async function runYesterdayAccountingSend(): Promise<{
  ok: boolean
  asked: boolean
  detail: string
}> {
  const today = todayYmdDhaka()
  const yesterday = yesterdayYmdDhaka(today)

  if (await isAccountingPendingToday(today)) return { ok: true, asked: false, detail: 'already_pending' }
  if (await hasKv(resolvedKey(today))) return { ok: true, asked: false, detail: 'already_resolved' }
  if (await hasKv(officeOffKey(yesterday))) return { ok: true, asked: false, detail: 'yesterday_no_office' }
  if (await wasDispatchDoneForDate(yesterday)) return { ok: true, asked: false, detail: 'dispatch_done' }

  const message = composeAccountingQuestion(yesterday)
  const conversationId = await getOrCreateDayShiftConversation(today)
  await appendShiftNarrative(conversationId, message)
  void sendOwnerText(message).catch(() => {})

  await prisma.agentKvSetting.upsert({
    where: { key: pendingKey(today) },
    create: {
      key: pendingKey(today),
      value: JSON.stringify({ yesterday, sentAt: new Date().toISOString() }),
    },
    update: { value: JSON.stringify({ yesterday, sentAt: new Date().toISOString() }) },
  })

  return { ok: true, asked: true, detail: `asked_for_${yesterday}` }
}

async function markResolved(todayYmd: string): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: resolvedKey(todayYmd) },
    create: { key: resolvedKey(todayYmd), value: 'resolved' },
    update: { value: 'resolved' },
  })
  await prisma.agentKvSetting.deleteMany({ where: { key: pendingKey(todayYmd) } })
}

function looksLikeReason(text: string): boolean {
  const t = text.trim()
  if (t.length < 3) return false
  if (/^(hi|hello|salam|asalam|ok|okay|thanks|thank you|ha|haan|na|hmm)$/i.test(t)) return false
  return true
}

export type AccountingReplyResult = {
  contextBlock?: string
  savedReason?: string
}

/**
 * Capture the owner's reply to the accounting question (first reply while pending).
 * Saves the reason to memory deterministically, then returns a contextBlock so the head
 * acknowledges + gives one concrete suggestion before proceeding with today's work.
 */
export async function processOwnerAccountingReply(
  text: string,
  _conversationId?: string,
): Promise<AccountingReplyResult | null> {
  const today = todayYmdDhaka()
  const trimmed = text.trim()
  if (!trimmed) return null
  if (!(await isAccountingPendingToday(today))) return null
  if (!looksLikeReason(trimmed)) return null

  const pendingRow = await prisma.agentKvSetting.findUnique({
    where: { key: pendingKey(today) },
    select: { value: true },
  })
  let yesterday = yesterdayYmdDhaka(today)
  try {
    if (pendingRow?.value) {
      const parsed = JSON.parse(pendingRow.value) as { yesterday?: string }
      if (parsed.yesterday) yesterday = parsed.yesterday.slice(0, 10)
    }
  } catch {
    /* use default yesterday */
  }

  const reason = trimmed.slice(0, 500)

  // Deterministic save — memory (for head context / RAG) + KV (for weekly-report query).
  try {
    await createOrUpdateAgentMemory({
      scope: 'business',
      key: missReasonKey(yesterday),
      content: `অফিসের মূল কাজ (স্টাফ dispatch) ${yesterday} তারিখে হয়নি। Owner-এর কারণ: ${reason}`,
      metadata: { type: 'office_miss_reason', date: yesterday, businessId: BUSINESS_ID },
      importance: 3,
    })
  } catch (err) {
    console.warn('[accounting] memory save failed:', err instanceof Error ? err.message : err)
  }
  await prisma.agentKvSetting.upsert({
    where: { key: missReasonKey(yesterday) },
    create: {
      key: missReasonKey(yesterday),
      value: JSON.stringify({ date: yesterday, reason, recordedAt: new Date().toISOString() }),
    },
    update: {
      value: JSON.stringify({ date: yesterday, reason, recordedAt: new Date().toISOString() }),
    },
  })

  await markResolved(today)

  return {
    savedReason: reason,
    contextBlock:
      `[YESTERDAY ACCOUNTING — ACTIVE]\n` +
      `Boss was asked why yesterday's (${yesterday}) main office work (staff task dispatch) did not happen. ` +
      `His reply (the reason) has ALREADY been saved to memory — do NOT call save_memory again for it. ` +
      `Respond in Bangla: (1) briefly + empathetically acknowledge the reason without blame, ` +
      `(2) give ONE concrete, practical suggestion so it does not repeat today, ` +
      `(3) then say you're starting today's office work. Keep it to 3-4 lines.`,
  }
}

export type MissReason = { date: string; reason: string }

/** Recent office-miss reasons (last `days` days) for the weekly report. */
export async function getRecentMissReasons(days = 7): Promise<MissReason[]> {
  const today = todayYmdDhaka()
  const keys: string[] = []
  for (let i = 1; i <= days; i++) keys.push(missReasonKey(addDaysYmd(today, -i)))

  const rows = await prisma.agentKvSetting.findMany({
    where: { key: { in: keys } },
    select: { value: true },
  })

  const out: MissReason[] = []
  for (const r of rows) {
    if (!r.value) continue
    try {
      const parsed = JSON.parse(r.value) as { date?: string; reason?: string }
      if (parsed.date && parsed.reason) out.push({ date: parsed.date, reason: parsed.reason })
    } catch {
      /* skip corrupt row */
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date))
}

/** Bangla section for the weekly review — empty string when nothing to report. */
export async function buildMissReasonsSection(days = 7): Promise<string> {
  const reasons = await getRecentMissReasons(days)
  if (reasons.length === 0) return ''
  const lines = reasons.map((r) => `• ${r.date}: ${r.reason}`).join('\n')
  return `📌 *অফিস কাজ মিস হওয়ার কারণ (${days} দিন):*\n${lines}`
}
