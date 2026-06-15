/**
 * Staff task dispatcher.
 * Called when owner approves the morning proposal (or add_staff_task_now).
 * Sends each staff member their Bangla task list via Telegram with [✅ Done] buttons.
 */

import { loggedSendToStaff } from '../telegram/logged-send.mjs'
import { taskDoneCallbackData } from '../telegram/callback-data.mjs'
import { sendNtfyToTopic } from '../notify/ntfy.mjs'
import { lunchButtonRow } from './lunch.mjs'
import { isStaffOnLeaveSb } from './leave.mjs'
import { leaveRequestButton } from './leave.mjs'

async function updateMorningDispatchDutyLog(supabase, result) {
  try {
    const dutyDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
    const anySent = (result?.sentTasks ?? 0) > 0
    await supabase.from('agent_duty_log').upsert(
      {
        duty: 'morning_dispatch',
        label: '📤 স্টাফ টাস্ক ডিসপ্যাচ',
        duty_date: dutyDate,
        status: anySent ? 'done' : 'skipped',
        detail: anySent ? `${result.sentTasks}টি পাঠানো` : 'কোনো approved টাস্ক ছিল না',
        ran_at: new Date().toISOString(),
      },
      { onConflict: 'duty,duty_date' },
    )
  } catch (e) {
    console.warn('[dispatch] duty-log update failed:', e.message)
  }
}

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

/**
 * @param {import('../staff/dispatch.mjs').DispatchResult | null | undefined} result
 */
export function formatDispatchOwnerReport(result) {
  if (!result || result.skipped) return null
  if (result.fullSuccess) {
    const bundled = result.priorSentBundled > 0
      ? ` (${result.priorSentBundled}টি আগের টাস্কসহ আপডেটেড লিস্ট)`
      : ''
    return `✅ ${result.sentTasks}টি নতুন কাজ ${result.sentToStaffCount} জন স্টাফকে পাঠানো হয়েছে${bundled} — সব নিশ্চিত।`
  }
  const lines = ['⚠️ কাজ পাঠানো হয়েছে — তবে সব যায়নি:']
  lines.push(`• পাঠানো: ${result.sentTasks}/${result.totalTasks}`)
  for (const f of result.failures ?? []) {
    lines.push(`• ❌ ${f.staffName} — যায়নি (${f.reason})`)
  }
  for (const u of result.unlinked ?? []) {
    lines.push(`• 🔗 ${u.staffName} — Telegram লিঙ্ক নেই`)
  }
  for (const o of result.onLeave ?? []) {
    lines.push(`• 🌿 ${o.staffName} আজ ছুটিতে — টাস্ক পাঠানো হয়নি`)
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

  const { data: tasks, error } = await query
  if (error) throw new Error(`DB error: ${error.message}`)
  const pending = (tasks ?? []).filter((t) => t.status === 'approved')

  if (taskIds?.length && pending.length !== taskIds.length) {
    console.warn(
      `[dispatch] payload taskIds (${taskIds.length}) != approved rows (${pending.length}) — using all approved for ${date}`,
    )
  }
  if (!pending.length) {
    console.warn('[dispatch] no approved tasks to dispatch for', date)
    const result = {
      date,
      totalTasks: 0,
      sentTasks: 0,
      sentToStaffCount: 0,
      priorSentBundled: 0,
      failures: [],
      unlinked: [],
      onLeave: [],
      fullSuccess: true,
      skipped: true,
    }
    await updateMorningDispatchDutyLog(supabase, result)
    return result
  }

  const staffIds = [...new Set(pending.map((t) => t.agent_staff?.id || t.staff_id).filter(Boolean))]
  const { data: priorSentRows } = await supabase
    .from('staff_tasks')
    .select(`*, agent_staff(id, name, role, telegramChatId)`)
    .eq('proposed_for', date)
    .eq('status', 'sent')
    .in('staff_id', staffIds)

  const priorSentByStaff = {}
  for (const t of priorSentRows ?? []) {
    const staffId = t.agent_staff?.id || t.staff_id
    if (!priorSentByStaff[staffId]) priorSentByStaff[staffId] = []
    priorSentByStaff[staffId].push(t)
  }

  const byStaff = {}
  for (const task of pending) {
    const staffId = task.agent_staff?.id || task.staff_id
    if (!byStaff[staffId]) byStaff[staffId] = { staff: task.agent_staff, tasks: [], priorSent: priorSentByStaff[staffId] ?? [] }
    byStaff[staffId].tasks.push(task)
  }

  const sentIds = []
  let priorSentBundled = 0
  const failures = []
  const unlinked = []
  const onLeave = []

  for (const { staff, tasks: staffTasks, priorSent } of Object.values(byStaff)) {
    const chatId = staff?.telegramChatId
    const staffName = staff?.name || 'স্টাফ'

    if (staff?.id && (await isStaffOnLeaveSb(supabase, staff.id, date))) {
      console.log(`[dispatch] ${staffName} on leave — skipping`)
      onLeave.push({ staffName, taskTitles: staffTasks.map((t) => t.title) })
      continue
    }

    if (!chatId) {
      console.warn(`[dispatch] ${staffName} has no Telegram ID — owner will get their tasks`)
      unlinked.push({ staffName, taskTitles: staffTasks.map((t) => t.title) })
      continue
    }

    const seen = new Set()
    const combinedTasks = []
    for (const t of [...priorSent, ...staffTasks]) {
      if (!seen.has(t.id)) {
        seen.add(t.id)
        combinedTasks.push(t)
      }
    }
    priorSentBundled += priorSent.length

    try {
      const isUpdate = priorSent.length > 0
      await sendTasksToStaff({
        bot,
        chatId,
        staffName,
        staffTasks: combinedTasks,
        supabase,
        staffId: staff.id,
        isUpdate,
        newCount: staffTasks.length,
      })
      sentIds.push(...staffTasks.map((t) => t.id))

      const { data: staffRow } = await supabase
        .from('agent_staff')
        .select('ntfyTopic, name')
        .eq('id', staff.id)
        .maybeSingle()
      if (staffRow?.ntfyTopic) {
        const ntfyMsg = isUpdate
          ? `${staffRow.name ?? staffName}, ${staffTasks.length}টি নতুন কাজ যোগ — মোট ${combinedTasks.length}টি। Telegram দেখুন।`
          : `${staffRow.name ?? staffName}, ${combinedTasks.length}টি নতুন কাজ — Telegram দেখুন।`
        await sendNtfyToTopic(
          staffRow.ntfyTopic,
          'আজকের কাজ',
          ntfyMsg,
          'task',
        ).catch((err) => console.warn(`[dispatch] ntfy failed for ${staffName}:`, err.message))
      }
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
    priorSentBundled,
    failures,
    unlinked,
    onLeave,
    fullSuccess: failures.length === 0 && unlinked.length === 0 && onLeave.length === 0 && verifiedSent === pending.length,
  }

  console.log('[dispatch] result:', JSON.stringify(result))

  await markDispatchActionsExecuted(supabase, date)
  await sendDispatchOwnerReport({ bot, result })
  await updateMorningDispatchDutyLog(supabase, result)
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

async function sendTasksToStaff({ bot, chatId, staffName, staffTasks, supabase, staffId, isUpdate = false, newCount = 0 }) {
  const numEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']

  const taskLines = staffTasks.map((t, i) => {
    const num = numEmojis[i] ?? `${i + 1}.`
    const detail = t.detail ? `\n   → ${t.detail}` : ''
    return `${num} ${t.title}${detail}`
  })

  const header = isUpdate
    ? `আজকের কাজ আপডেট (${staffTasks.length}টি${newCount ? ` — ${newCount}টি নতুন` : ''}):`
    : `আজকের কাজ (${staffTasks.length}টি):`

  const msg =
    `আস্সালামু আলাইকুম ${staffName} ভাই! 📋\n\n` +
    `${header}\n\n` +
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
    rows.push(lunchButtonRow())
    rows.push([leaveRequestButton()])
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
    requiresAck: true,
    extra: { reply_markup: { inline_keyboard: rows } },
  })

  if (!sendResult.ok) {
    throw new Error(sendResult.error ?? 'task dispatch send failed')
  }
}
