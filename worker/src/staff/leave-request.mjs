/**
 * Staff leave request flow — staff applies, owner approves/rejects via Telegram.
 */

import { replyMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'
import { dhakaToday } from './leave.mjs'

/** @param {import('telegraf').Context} ctx */
export async function handleLeaveRequest(ctx, supabase, staff) {
  const today = dhakaToday()

  const { data: existing } = await supabase
    .from('staff_leave')
    .select('id, status')
    .eq('staff_id', staff.id)
    .lte('start_date', today)
    .gte('end_date', today)
    .in('status', ['requested', 'approved'])
    .maybeSingle()

  if (existing) {
    const note = existing.status === 'approved' ? 'আজ ইতিমধ্যে ছুটিতে আছেন।' : 'আজকের ছুটির আবেদন ইতিমধ্যে পাঠানো হয়েছে — owner এর উত্তরের অপেক্ষায়।'
    await replyMarkdownSafe(ctx, `ℹ️ ${staff.name} ভাই, ${note}`)
    return
  }

  const id = crypto.randomUUID()
  await supabase.from('staff_leave').insert({
    id,
    staff_id: staff.id,
    staff_name: staff.name,
    business_id: 'ALMA_LIFESTYLE',
    start_date: today,
    end_date: today,
    type: 'leave',
    status: 'requested',
    reason: 'টেলিগ্রাম আবেদন',
  })

  await replyMarkdownSafe(
    ctx,
    `🌿 ${staff.name} ভাই, ছুটির আবেদন পাঠানো হয়েছে। Owner approve করলে আজ absent/fine/task হবে না — ইনশাআল্লাহ। 🤲`,
  )

  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (ownerChatId && ctx.telegram) {
    await sendMarkdownSafe(
      ctx.telegram,
      ownerChatId,
      `🌿 *ছুটির আবেদন*\n\n${staff.name} ভাই আজ (${today}) ছুটি চেয়েছেন।`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `leave_approve:${id}` },
            { text: '❌ Reject', callback_data: `leave_reject:${id}` },
          ]],
        },
      },
    ).catch(() => {})
  }
}

/** @param {import('telegraf').Context} ctx */
export async function handleLeaveApprove(ctx, supabase, leaveId, isOwner) {
  if (!isOwner) {
    await ctx.answerCbQuery('অনুমতি নেই')
    return
  }

  const { data: row } = await supabase
    .from('staff_leave')
    .select('id, staff_id, staff_name, start_date, end_date, status')
    .eq('id', leaveId)
    .maybeSingle()

  if (!row) {
    await ctx.answerCbQuery('আবেদন পাওয়া যায়নি')
    return
  }
  if (row.status === 'approved') {
    await ctx.answerCbQuery('ইতিমধ্যে approve')
    return
  }

  await supabase
    .from('staff_leave')
    .update({ status: 'approved', approved_by: 'owner' })
    .eq('id', leaveId)

  await ctx.answerCbQuery('✅ ছুটি approve')

  const { data: staff } = await supabase
    .from('agent_staff')
    .select('telegramChatId, name')
    .eq('id', row.staff_id)
    .maybeSingle()

  if (staff?.telegramChatId && ctx.telegram) {
    await sendMarkdownSafe(
      ctx.telegram,
      staff.telegramChatId,
      `✅ ${staff.name ?? row.staff_name} ভাই, আপনার ছুটির আবেদন approve হয়েছে (${row.start_date}${row.end_date !== row.start_date ? ` – ${row.end_date}` : ''})। আল্লাহ সুস্থতা দিন। 🤲`,
    ).catch(() => {})
  }

  if (ctx.callbackQuery?.message) {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
  }
}

/** @param {import('telegraf').Context} ctx */
export async function handleLeaveReject(ctx, supabase, leaveId, isOwner) {
  if (!isOwner) {
    await ctx.answerCbQuery('অনুমতি নেই')
    return
  }

  const { data: row } = await supabase
    .from('staff_leave')
    .select('id, staff_id, staff_name, status')
    .eq('id', leaveId)
    .maybeSingle()

  if (!row) {
    await ctx.answerCbQuery('আবেদন পাওয়া যায়নি')
    return
  }

  await supabase.from('staff_leave').update({ status: 'rejected', approved_by: 'owner' }).eq('id', leaveId)
  await ctx.answerCbQuery('❌ reject করা হয়েছে')

  const { data: staff } = await supabase
    .from('agent_staff')
    .select('telegramChatId, name')
    .eq('id', row.staff_id)
    .maybeSingle()

  if (staff?.telegramChatId && ctx.telegram) {
    await sendMarkdownSafe(
      ctx.telegram,
      staff.telegramChatId,
      `ℹ️ ${staff.name ?? row.staff_name} ভাই, আজকের ছুটির আবেদন approve হয়নি। কোনো সমস্যা থাকলে Boss এর সাথে কথা বলুন।`,
    ).catch(() => {})
  }

  if (ctx.callbackQuery?.message) {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
  }
}

export function isLeaveRequestText(text) {
  const t = text.trim()
  return t === 'ছুটি চাই' || t.toLowerCase() === 'leave request'
}
