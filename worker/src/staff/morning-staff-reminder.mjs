/**
 * Morning Staff Reminder — 09:00 Asia/Dhaka
 * Tasks are proposed the previous evening; morning only dispatches + reminds + tracks.
 */

import { dispatchTasksToStaff } from './dispatch.mjs'

export async function runMorningStaffReminder({ supabase, bot }) {
  console.log('[morning-staff-reminder] starting...')
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  const { data: approved } = await supabase
    .from('staff_tasks')
    .select('id')
    .eq('proposed_for', today)
    .eq('status', 'approved')

  if (approved?.length && bot) {
    const taskIds = approved.map((t) => t.id)
    console.log(`[morning-staff-reminder] dispatching ${taskIds.length} approved tasks`)
    await dispatchTasksToStaff({ supabase, bot, date: today, taskIds })
  } else {
    console.log(`[morning-staff-reminder] 0 approved tasks for ${today} — checking if proposals exist`)
    const { count: proposedCount } = await supabase
      .from('staff_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('proposed_for', today)
      .eq('status', 'proposed')
    if (proposedCount > 0) {
      console.warn(`[morning-staff-reminder] ${proposedCount} tasks proposed but NOT approved — owner didn't approve last night's proposal`)
    }
  }

  const { data: sentTasks } = await supabase
    .from('staff_tasks')
    .select(`*, agent_staff(id, name, telegramChatId)`)
    .eq('proposed_for', today)
    .eq('status', 'sent')

  if (!sentTasks?.length) {
    console.log('[morning-staff-reminder] no sent tasks to remind')
    return
  }

  const byStaff = {}
  for (const t of sentTasks) {
    const staffId = t.agent_staff?.id || t.staff_id
    if (!byStaff[staffId]) byStaff[staffId] = { staff: t.agent_staff, tasks: [] }
    byStaff[staffId].tasks.push(t)
  }

  for (const { staff, tasks } of Object.values(byStaff)) {
    const chatId = staff?.telegramChatId
    const staffName = staff?.name || 'স্টাফ'
    if (!chatId || !bot) continue

    const taskList = tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')
    await bot.telegram.sendMessage(
      chatId,
      `🌅 সুপ্রভাত ${staffName} ভাই!\n\n` +
        `📋 *আজকের কাজের তালিকা:*\n\n${taskList}\n\n` +
        `শেষ হলে ✅ Done বাটন চাপুন।`,
      { parse_mode: 'Markdown' },
    ).catch((err) => console.warn(`[morning-staff-reminder] ${staffName}:`, err.message))
  }

  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (ownerChatId && bot) {
    const total = sentTasks.length
    const names = [...new Set(sentTasks.map((t) => t.agent_staff?.name || 'স্টাফ'))].join(', ')
    await bot.telegram.sendMessage(
      ownerChatId,
      `🌅 *সকাল ৯টা — স্টাফ ট্র্যাকিং শুরু*\n\n` +
        `${names}: মোট ${total}টি কাজ active। দুপুর ১:৩০ ও রাত ৯টায় আপডেট আসবে।`,
      { parse_mode: 'Markdown' },
    ).catch(() => {})
  }

  console.log(`[morning-staff-reminder] reminded ${Object.keys(byStaff).length} staff`)
}
