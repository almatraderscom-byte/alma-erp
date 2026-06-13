/**
 * Staff task dispatcher.
 * Called when owner approves the morning proposal (or add_staff_task_now).
 * Sends each staff member their Bangla task list via Telegram with [✅ Done] buttons.
 */

import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { taskDoneCallbackData } from '../telegram/callback-data.mjs'

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

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
    return
  }

  // Group by staff member
  const byStaff = {}
  for (const task of pending) {
    const staffId = task.agent_staff?.id || task.staff_id
    if (!byStaff[staffId]) byStaff[staffId] = { staff: task.agent_staff, tasks: [] }
    byStaff[staffId].tasks.push(task)
  }

  const sentIds = []

  for (const { staff, tasks: staffTasks } of Object.values(byStaff)) {
    const chatId = staff?.telegramChatId
    const staffName = staff?.name || 'স্টাফ'

    if (!chatId) {
      console.warn(`[dispatch] ${staffName} has no Telegram ID — owner will get their tasks`)
      await notifyOwnerOfUnlinkedStaff(bot, staffName, staffTasks)
      continue
    }

    try {
      await sendTasksToStaff({ bot, chatId, staffName, staffTasks, supabase })
      sentIds.push(...staffTasks.map((t) => t.id))
    } catch (err) {
      console.warn(`[dispatch] Telegram failed for ${staffName} (${chatId}):`, err.message)
      await notifyOwnerTelegramFailed(bot, staffName, chatId, staffTasks, err.message)
    }
  }

  if (sentIds.length) {
    await supabase.from('staff_tasks').update({ status: 'sent' }).in('id', sentIds)
  }

  console.log(`[dispatch] sent ${sentIds.length}/${pending.length} tasks to ${Object.keys(byStaff).length} staff`)
}

async function sendTasksToStaff({ bot, chatId, staffName, staffTasks, supabase }) {
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

  await sendMarkdownSafe(bot.telegram, chatId, msg, {
    reply_markup: { inline_keyboard: rows },
  })
}

async function notifyOwnerTelegramFailed(bot, staffName, chatId, tasks, errorMsg) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId) return

  const taskList = tasks.map((t) => `• ${t.title}`).join('\n')
  await bot.telegram.sendMessage(
    ownerChatId,
    `⚠️ *${staffName}*-কে Telegram-এ মেসেজ যায়নি (chat \`${chatId}\`).\n` +
      `কারণ: ${errorMsg}\n\n` +
      `কাজ:\n${taskList}\n\n` +
      `লিঙ্ক ঠিক থাকলেও বাটন ডেটা ভাঙলে মেসেজ যায় না — worker আপডেট করুন।\n` +
      `${staffName} *ALMA Assistant* বটে /start করুক।`,
    { parse_mode: 'Markdown' },
  )
}

async function notifyOwnerOfUnlinkedStaff(bot, staffName, tasks) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId) return

  const taskList = tasks.map(t => `• ${t.title}`).join('\n')
  await bot.telegram.sendMessage(
    ownerChatId,
    `⚠️ *${staffName}*-এর Telegram লিঙ্ক নেই।\n\nতাদের কাজ:\n${taskList}\n\n/staff link ${staffName} <chat_id> দিয়ে লিঙ্ক করুন।`,
    { parse_mode: 'Markdown' },
  )
}
