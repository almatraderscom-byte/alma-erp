/**
 * Staff task dispatcher.
 * Called when owner approves the morning proposal (or add_staff_task_now).
 * Sends each staff member their Bangla task list via Telegram with [✅ Done] buttons.
 */

import { loggedSendToStaff } from '../telegram/logged-send.mjs'
import { taskDoneCallbackData } from '../telegram/callback-data.mjs'

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

/**
 * @param {import('../staff/dispatch.mjs').DispatchResult | null | undefined} result
 */
export function formatDispatchOwnerReport(result) {
  if (!result || result.skipped) return null
  if (result.fullSuccess) {
    return `✅ ${result.sentTasks}টি কাজ ${result.sentToStaffCount} জন স্টাফকে পাঠানো হয়েছে — সব নিশ্চিত।`
  }
  const lines = ['⚠️ কাজ পাঠানো হয়েছে — তবে সব যায়নি:']
  lines.push(`• পাঠানো: ${result.sentTasks}/${result.totalTasks}`)
  for (const f of result.failures ?? []) {
    lines.push(`• ❌ ${f.staffName} — যায়নি (${f.reason})`)
  }
  for (const u of result.unlinked ?? []) {
    lines.push(`• 🔗 ${u.staffName} — Telegram লিঙ্ক নেই`)
  }
  return lines.join('\n')
}

/**
 * @param {object} params
 * @param {import('telegraf').Telegraf} params.bot
 * @param {import('../staff/dispatch.mjs').DispatchResult | null | undefined} params.result
 */
export async function sendDispatchOwnerReport({ bot, result }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  const report = formatDispatchOwnerReport(result)
  if (!ownerChatId || !report) return
  await bot.telegram.sendMessage(ownerChatId, report).catch((err) => {
    console.warn('[dispatch] owner report failed:', err.message)
  })
}

/**
 * Dispatches approved tasks for a given date to each staff member.
 * @param {object} params
 * @param {import('@supabase/supabase-js').SupabaseClient} params.supabase
 * @param {import('telegraf').Telegraf} params.bot
 * @param {string} params.date — YYYY-MM-DD
 * @param {string[]} params.taskIds — specific task IDs to dispatch (or all approved for date)
 */
export async function dispatchTasksToStaff({ supabase, bot, date, taskIds }) {
  console.log(`[dispatch] dispatching tasks for ${date}`)

  const query = supabase
    .from('staff_tasks')
    .select(`*, agent_staff(id, name, role, telegramChatId)`)
    .eq('status', 'approved')
    .eq('proposed_for', date)

  if (taskIds?.length) {
    query.in('id', taskIds)
  }

  const { data: tasks, error } = await query
  if (error) throw new Error(`DB error: ${error.message}`)
  const pending = (tasks ?? []).filter((t) => t.status === 'approved')
  if (!pending.length) {
    console.warn('[dispatch] no approved tasks to dispatch for', date)
    return {
      date,
      totalTasks: 0,
      sentTasks: 0,
      sentToStaffCount: 0,
      failures: [],
      unlinked: [],
      fullSuccess: true,
      skipped: true,
    }
  }

  // Group by staff member
  const byStaff = {}
  for (const task of pending) {
    const staffId = task.agent_staff?.id || task.staff_id
    if (!byStaff[staffId]) byStaff[staffId] = { staff: task.agent_staff, tasks: [] }
    byStaff[staffId].tasks.push(task)
  }

  const sentIds = []
  const failures = []
  const unlinked = []

  for (const { staff, tasks: staffTasks } of Object.values(byStaff)) {
    const chatId = staff?.telegramChatId
    const staffName = staff?.name || 'স্টাফ'

    if (!chatId) {
      console.warn(`[dispatch] ${staffName} has no Telegram ID — owner will get their tasks`)
      unlinked.push({ staffName, taskTitles: staffTasks.map((t) => t.title) })
      continue
    }

    try {
      await sendTasksToStaff({ bot, chatId, staffName, staffTasks, supabase, staffId: staff.id })
      sentIds.push(...staffTasks.map((t) => t.id))
    } catch (err) {
      console.warn(`[dispatch] Telegram failed for ${staffName} (${chatId}):`, err.message)
      failures.push({
        staffName,
        chatId,
        reason: err.message,
        taskTitles: staffTasks.map((t) => t.title),
      })
    }
  }

  // READ-BACK VERIFICATION: confirm the rows actually flipped to 'sent'
  let verifiedSent = 0
  if (sentIds.length) {
    await supabase.from('staff_tasks').update({ status: 'sent' }).in('id', sentIds)
    const { data: check } = await supabase
      .from('staff_tasks')
      .select('id, status')
      .in('id', sentIds)
    verifiedSent = (check ?? []).filter((r) => r.status === 'sent').length
  }

  const result = {
    date,
    totalTasks: pending.length,
    sentTasks: verifiedSent,
    sentToStaffCount: Object.keys(byStaff).length - failures.length - unlinked.length,
    failures,
    unlinked,
    fullSuccess: failures.length === 0 && unlinked.length === 0 && verifiedSent === pending.length,
  }

  console.log('[dispatch] result:', JSON.stringify(result))

  await markDispatchActionsExecuted(supabase, date)
  await sendDispatchOwnerReport({ bot, result })
  return result
}

/** Prevent double-dispatch cards — close all pending/approved dispatch actions for a date. */
export async function markDispatchActionsExecuted(supabase, date) {
  const { data: actions } = await supabase
    .from('agent_pending_actions')
    .select('id, payload, status')
    .eq('type', 'dispatch_staff_tasks')
    .in('status', ['pending', 'approved'])

  const now = new Date().toISOString()
  for (const a of actions ?? []) {
    if (a.payload?.date === date) {
      await supabase
        .from('agent_pending_actions')
        .update({ status: 'executed', resolvedAt: now })
        .eq('id', a.id)
    }
  }
}

async function sendTasksToStaff({ bot, chatId, staffName, staffTasks, supabase, staffId }) {
  const numEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']

  const taskLines = staffTasks.map((t, i) => {
    const num = numEmojis[i] ?? `${i + 1}.`
    const detail = t.detail ? `\n   → ${t.detail}` : ''
    return `${num} ${t.title}${detail}`
  })

  const msg =
    `আস্সালামু আলাইকুম ${staffName} ভাই! 📋\n\n` +
    `আজকের কাজ (${staffTasks.length}টি):\n\n` +
    taskLines.join('\n\n') +
    `\n\nপ্রতিটা শেষ হলে নিচে Done চাপুন ✅`

  const buttons = staffTasks.map((t, i) => ({
    text: `✅ ${i + 1} Done`,
    callback_data: taskDoneCallbackData(t.id),
  }))

  const rows = []
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2))
  }
  if (staffId) {
    rows.push([{ text: '💬 Feedback দিন', callback_data: `staff_feedback_open:${staffId}` }])
  }

  const sendResult = await loggedSendToStaff(bot.telegram, {
    supabase,
    staffId,
    staffName,
    businessId: 'ALMA_LIFESTYLE',
    type: 'task_dispatch',
    content: msg,
    chatId,
    relatedTaskIds: staffTasks.map((t) => t.id),
    extra: { reply_markup: { inline_keyboard: rows } },
  })

  if (!sendResult.ok) {
    throw new Error(sendResult.error ?? 'task dispatch send failed')
  }
}
