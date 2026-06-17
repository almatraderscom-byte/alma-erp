/**
 * Morning Staff Reminder — 09:00 Asia/Dhaka
 * Tasks are proposed the previous evening; morning only dispatches + reminds + tracks.
 */

import { dispatchTasksToStaff } from './dispatch.mjs'
import { notify } from '../notify/index.mjs'
import { loggedSendToStaff } from '../telegram/logged-send.mjs'
import { lunchButtonRow } from './lunch.mjs'
import { leaveRequestButton } from './leave.mjs'

export async function runMorningStaffReminder({ supabase, bot }) {
  console.log('[morning-staff-reminder] starting...')
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

  const { data: openGate } = await supabase
    .from('agent_pending_actions')
    .select('id, payload, status')
    .eq('type', 'dispatch_staff_tasks')
    .eq('status', 'pending')

  const gateBlocksToday = (openGate ?? []).some((a) => {
    const d = a.payload?.date
    return d === today || String(d).slice(0, 10) === today
  })

  const { data: approved } = await supabase
    .from('staff_tasks')
    .select('id')
    .eq('proposed_for', today)
    .eq('status', 'approved')

  if (approved?.length && bot) {
    if (gateBlocksToday) {
      console.warn('[morning-staff-reminder] dispatch gate still pending — skip auto-dispatch')
      await notify({
        tier: 2,
        title: 'সকাল ডিসপ্যাচ ব্লক',
        message: `আজকের ${approved.length}টি approved টাস্ক আছে কিন্তু evening proposal gate এখনো pending। Telegram থেকে approve করুন।`,
        category: 'urgent',
      })
      return { dutyStatus: 'skipped', dutyDetail: 'dispatch_staff_tasks gate still pending' }
    }
    const taskIds = approved.map((t) => t.id)
    console.log(`[morning-staff-reminder] dispatching ${taskIds.length} approved tasks`)
    await dispatchTasksToStaff({ supabase, bot, date: today, taskIds })
  } else {
    const { count: proposedCount } = await supabase
      .from('staff_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('proposed_for', today)
      .eq('status', 'proposed')

    const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID

    if (proposedCount > 0) {
      console.warn(`[morning-staff-reminder] ${proposedCount} proposed but UNAPPROVED at 09:00 — escalating`)
      await notify({
        tier: 3,
        title: 'সকাল ৯টা — টাস্ক approve হয়নি',
        message: `আজকের ${proposedCount}টি কাজ এখনো approve হয়নি। স্টাফরা কাজ পাচ্ছে না। এখনই approve করুন।`,
        voiceMessage: `সালাম স্যার। আজকের স্টাফ টাস্ক এখনো approve করা হয়নি। ${proposedCount}টি কাজ অপেক্ষা করছে। দয়া করে এখনই approve করুন, নাহলে স্টাফরা কাজ পাবে না।`,
        category: 'urgent',
      })
      if (ownerChatId && bot) {
        await bot.telegram.sendMessage(
          ownerChatId,
          `🔴 আজকের ${proposedCount}টি কাজ approve হয়নি — স্টাফদের কাছে এখনো পাঠানো হয়নি।\n\nApprove করলেই সাথে সাথে পাঠানো হবে।`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ এখন Approve করুন', callback_data: `proposal_approve:${today}` },
              ]],
            },
          },
        ).catch((err) => {
          console.warn('[morning-staff-reminder] approval escalation send failed:', err.message)
        })
      }
      return { dutyStatus: 'skipped', dutyDetail: `${proposedCount}টি কাজ approve হয়নি` }
    }

    console.error('[morning-staff-reminder] NO proposal found for today — generation may have failed')
    await notify({
      tier: 2,
      title: '⚠️ আজকের কোনো task proposal নেই',
      message: 'গতরাতে proposal তৈরি হয়নি। Evening-proposal scheduler চেক করুন।',
      category: 'urgent',
    })
    return { dutyStatus: 'skipped', dutyDetail: 'গতরাতে proposal তৈরি হয়নি' }
  }

  const { data: sentTasks } = await supabase
    .from('staff_tasks')
    .select(`*, agent_staff(id, name, telegramChatId)`)
    .eq('proposed_for', today)
    .eq('status', 'sent')

  if (!sentTasks?.length) {
    console.log('[morning-staff-reminder] no sent tasks to remind')
    return { dutyStatus: 'done', dutyDetail: 'ডিসপ্যাচ সম্পন্ন — রিমাইন্ডারের মতো কিছু নেই' }
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
    const reminderMsg =
      `🌅 সুপ্রভাত ${staffName} ভাই!\n\n` +
      `📋 *আজকের কাজের তালিকা:*\n\n${taskList}\n\n` +
      `শেষ হলে ✅ Done বাটন চাপুন।`

    await loggedSendToStaff(bot.telegram, {
      supabase,
      staffId: staff.id,
      staffName,
      businessId: 'ALMA_LIFESTYLE',
      type: 'reminder',
      content: reminderMsg,
      chatId,
      relatedTaskIds: tasks.map((t) => t.id),
      extra: {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Feedback দিন', callback_data: `staff_feedback_open:${staff.id}` }],
            lunchButtonRow(),
            [leaveRequestButton()],
          ],
        },
      },
    }).catch((err) => console.warn(`[morning-staff-reminder] ${staffName}:`, err.message))
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
    ).catch((err) => {
      console.warn('[morning-staff-reminder] owner summary send failed:', err.message)
    })
  }

  console.log(`[morning-staff-reminder] reminded ${Object.keys(byStaff).length} staff`)
  return { dutyStatus: 'done' }
}
