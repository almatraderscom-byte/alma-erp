/**
 * Staff task dispatcher.
 * Called when owner approves the morning proposal (or add_staff_task_now).
 * Sends each staff member their Bangla task list via Telegram with [✅ Done] buttons.
 */

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
  // Build task list message
  const taskLines = staffTasks.map((t, i) =>
    `${i + 1}. ${t.title}${t.detail ? `\n   _${t.detail}_` : ''}`
  )

  const msg =
    `আস্সালামু আলাইকুম ${staffName} ভাই!\n\n` +
    `📋 *আজকের কাজের তালিকা:*\n\n` +
    taskLines.join('\n\n')

  await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' })

  // Send each task as individual Done button
  for (const task of staffTasks) {
    await bot.telegram.sendMessage(
      chatId,
      `✏️ *${task.title}*${task.detail ? `\n${task.detail}` : ''}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            // Telegram callback_data max 64 bytes — task UUID only (staff resolved on tap).
            { text: '✅ Done', callback_data: `task_done:${task.id}` },
          ]],
        },
      },
    )
  }
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
