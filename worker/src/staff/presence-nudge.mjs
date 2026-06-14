import { loggedSendToStaff } from '../telegram/logged-send.mjs'

const DONE_STATUSES = new Set(['done', 'done_unverified', 'verified'])

/**
 * One-way presence nudge. Status-aware: praises progress, gently pokes if nothing done.
 * Staff replies are NOT answered here — outbound only.
 */
export async function runStaffPresence({ supabase, bot }) {
  if (!bot) return

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const hourDhaka = Number(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', hour: '2-digit', hour12: false }),
  )

  const { data: tasks } = await supabase
    .from('staff_tasks')
    .select('id, status, title, type, staff_id, agent_staff(id, name, telegramChatId)')
    .eq('proposed_for', today)
    .in('status', ['sent', 'done', 'done_unverified', 'verified'])

  if (!tasks?.length) return

  const byStaff = {}
  for (const t of tasks) {
    if (t.type === 'learning') continue
    const s = t.agent_staff
    if (!s?.telegramChatId) continue
    byStaff[s.id] ??= { staff: s, total: 0, done: 0 }
    byStaff[s.id].total++
    if (DONE_STATUSES.has(t.status)) byStaff[s.id].done++
  }

  for (const { staff, total, done } of Object.values(byStaff)) {
    const pct = total ? Math.round((done / total) * 100) : 0
    let msg
    if (done === total && total > 0) {
      msg = `👏 ${staff.name} ভাই, সব কাজ শেষ — দারুণ! এজেন্ট খেয়াল রাখছে, আপনার পরিশ্রম owner দেখছেন।`
    } else if (done === 0 && hourDhaka >= 11) {
      msg = `👀 ${staff.name} ভাই, এখনো কোনো কাজ শুরু হয়নি দেখছি। একটা একটা করে শুরু করুন — এজেন্ট সারাদিন সাথে আছে।`
    } else {
      msg = `📊 ${staff.name} ভাই, ${done}/${total} শেষ (${pct}%)। এগিয়ে যান — track করছি।`
    }

    await loggedSendToStaff(bot.telegram, {
      supabase,
      staffId: staff.id,
      staffName: staff.name,
      businessId: 'ALMA_LIFESTYLE',
      type: 'presence',
      content: msg,
      chatId: staff.telegramChatId,
      extra: {
        reply_markup: {
          inline_keyboard: [[
            { text: '💬 Feedback দিন', callback_data: `staff_feedback_open:${staff.id}` },
          ]],
        },
      },
    }).catch(() => {})
  }
}
