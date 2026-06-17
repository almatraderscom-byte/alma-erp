/**
 * Nightly scoreboard — DB counts only, zero LLM.
 */
import { bnNum } from './bn-format.mjs'
import { loggedSendToStaff } from '../telegram/logged-send.mjs'

const DONE_STATUSES = new Set(['done', 'done_unverified'])

function dhakaDateOffset(baseYmd, days) {
  const d = new Date(`${baseYmd}T12:00:00+06:00`)
  d.setDate(d.getDate() + days)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function isWorkDone(task) {
  return DONE_STATUSES.has(task.status) && task.type !== 'learning'
}

function isWorkActive(task) {
  return task.type !== 'learning' && task.status !== 'cancelled'
}

async function dayWorkStats(supabase, staffId, dateYmd) {
  const { data: rows } = await supabase
    .from('staff_tasks')
    .select('status, type')
    .eq('proposed_for', dateYmd)
    .eq('staff_id', staffId)
    .neq('status', 'cancelled')

  const work = (rows ?? []).filter(isWorkActive)
  const done = work.filter(isWorkDone)
  return { done: done.length, total: work.length }
}

async function computeStreak(supabase, staffId, todayYmd) {
  let streak = 0
  for (let i = 0; i < 14; i++) {
    const d = dhakaDateOffset(todayYmd, -i)
    const { done, total } = await dayWorkStats(supabase, staffId, d)
    if (total === 0) continue
    if (done >= total) streak++
    else break
  }
  return streak
}

function firstName(full) {
  const parts = String(full ?? '').trim().split(/\s+/)
  return parts[0] || 'স্টাফ'
}

/**
 * @returns {{ ownerBlock: string, perStaff: Array<{ staffId, staffName, chatId, line: string }> }}
 */
export async function buildDailyScoreboard(supabase, todayYmd, byStaffFromTasks) {
  const lines = ['🏁 *আজকের স্কোর*']
  const perStaff = []

  for (const { staff, done, pending } of byStaffFromTasks) {
    const staffId = staff?.id
    const staffName = staff?.name ?? 'অজানা'
    const workDone = done.filter((t) => t.type !== 'learning')
    const workPending = pending.filter((t) => t.type !== 'learning')
    const workTotal = workDone.length + workPending.length
    if (workTotal === 0) continue

    const streak = staffId ? await computeStreak(supabase, staffId, todayYmd) : 0
    const short = firstName(staffName)
    const pendingCount = workPending.length

    let line = `• ${short} — ${bnNum(workDone.length)}/${bnNum(workTotal)} শেষ`
    if (pendingCount === 0) line += ' ✅'
    else line += `, ${bnNum(pendingCount)}টা বাকি`
    if (streak >= 2) line += ` (${bnNum(streak)} দিন streak 🔥)`
    lines.push(line)

    const staffLine =
      pendingCount === 0
        ? `🏁 আজ ${bnNum(workDone.length)}/${bnNum(workTotal)} কাজ শেষ ✅${streak >= 2 ? ` — ${bnNum(streak)} দিন streak 🔥` : ''}`
        : `🏁 আজ ${bnNum(workDone.length)}/${bnNum(workTotal)} শেষ — ${bnNum(pendingCount)}টা বাকি। ✅ Done চাপুন।`

    perStaff.push({
      staffId,
      staffName,
      chatId: staff?.telegramChatId,
      line: staffLine,
    })
  }

  return { ownerBlock: lines.join('\n'), perStaff }
}

export async function sendScoreboardToStaff({ supabase, bot, perStaff, businessId = 'ALMA_LIFESTYLE' }) {
  if (!bot?.telegram) return 0
  let sent = 0
  for (const row of perStaff) {
    if (!row.chatId) continue
    await loggedSendToStaff(bot.telegram, {
      supabase,
      staffId: row.staffId,
      staffName: row.staffName,
      businessId,
      type: 'scoreboard',
      content: row.line,
      chatId: row.chatId,
      requiresAck: false,
    }).catch((err) => {
      console.warn(`[scoreboard] staff send failed ${row.staffName}:`, err.message)
      return bot.telegram.sendMessage(row.chatId, row.line).catch(() => {})
    })
    sent++
  }
  return sent
}
