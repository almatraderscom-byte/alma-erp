/**
 * Midday Check-In Job — 13:30 Asia/Dhaka
 * - Gentle Bangla reminder to staff members with pending tasks
 * - One-line update to owner only if something is stuck
 */

import { loggedSendToStaff } from '../telegram/logged-send.mjs'

export async function runMiddayCheckin({ supabase, bot }) {
  console.log('[midday-checkin] starting...')

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  const { data: pendingTasks } = await supabase
    .from('staff_tasks')
    .select(`*, agent_staff(id, name, telegramChatId)`)
    .eq('proposed_for', today)
    .eq('status', 'sent')
    .neq('type', 'learning')

  if (!pendingTasks?.length) {
    console.log('[midday-checkin] all tasks done — no reminders needed')
    return { dutyStatus: 'done', dutyDetail: 'সব কাজ সম্পন্ন, রিমাইন্ডার দরকার নেই' }
  }

  // Group by staff
  const byStaff = {}
  for (const t of pendingTasks) {
    const staffId = t.agent_staff?.id || t.staff_id
    if (!byStaff[staffId]) byStaff[staffId] = { staff: t.agent_staff, tasks: [] }
    byStaff[staffId].tasks.push(t)
  }

  const stuckStaff = []

  for (const { staff, tasks } of Object.values(byStaff)) {
    const chatId = staff?.telegramChatId
    const staffName = staff?.name || 'স্টাফ'

    if (chatId) {
      const taskList = tasks.map(t => `• ${t.title}`).join('\n')
      const msg =
        `🌤 ${staffName} ভাই, এগুলো এখনো পেন্ডিং:\n\n${taskList}\n\nপ্রতিটি কাজ শেষ হলে ✅ Done বাটন চাপুন।`
      await loggedSendToStaff(bot.telegram, {
        supabase,
        staffId: staff?.id,
        staffName,
        businessId: 'ALMA_LIFESTYLE',
        type: 'reminder',
        content: msg,
        chatId,
        relatedTaskIds: tasks.map((t) => t.id),
      }).catch(err => console.warn(`[midday] reminder to ${staffName} failed:`, err.message))
    }

    stuckStaff.push(`${staffName} (${tasks.length}টি বাকি)`)
  }

  // Owner summary only if any pending
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (ownerChatId && stuckStaff.length > 0) {
    await bot.telegram.sendMessage(
      ownerChatId,
      `⏰ দুপুর আপডেট: ${stuckStaff.join(', ')} — রিমাইন্ডার পাঠানো হয়েছে।`,
    ).catch(err => console.warn('[midday] owner update failed:', err.message))
  }

  console.log(`[midday-checkin] sent reminders for ${pendingTasks.length} pending tasks`)
  return {
    dutyStatus: 'done',
    dutyDetail: `${stuckStaff.length} স্টাফকে রিমাইন্ডার, ${pendingTasks.length}টি পেন্ডিং টাস্ক`,
  }
}
