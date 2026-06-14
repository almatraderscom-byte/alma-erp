import { loggedSendToStaff } from '../telegram/logged-send.mjs'

/** staffChatId → staffId */
export const awaitingStaffFeedback = new Map()

export async function handleStaffFeedbackOpen(ctx, staffId) {
  awaitingStaffFeedback.set(String(ctx.chat?.id), staffId)
  await ctx.answerCbQuery?.('লিখুন')
  await ctx.reply('আপনার মতামত/সমস্যা লিখুন — owner কে জানানো হবে।')
}

export async function captureStaffFeedback(ctx, supabase, staff, text) {
  const chatId = String(ctx.chat?.id ?? '')
  if (!awaitingStaffFeedback.has(chatId)) return false

  awaitingStaffFeedback.delete(chatId)
  const message = text.trim().slice(0, 4000)
  if (!message) return false

  await supabase.from('staff_feedback').insert({
    id: crypto.randomUUID(),
    staff_id: staff.id,
    message,
    seen_by_owner: false,
    created_at: new Date().toISOString(),
  })

  const ownerId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (ownerId) {
    await ctx.telegram.sendMessage(
      ownerId,
      `💬 ${staff.name} feedback দিয়েছে:\n\n"${message.slice(0, 800)}"`,
    ).catch(() => {})
  }

  const ack = '✅ জানানো হয়েছে — owner দেখবেন।'
  await loggedSendToStaff(ctx.telegram, {
    supabase,
    staffId: staff.id,
    staffName: staff.name,
    businessId: 'ALMA_LIFESTYLE',
    type: 'feedback_ack',
    content: ack,
    chatId,
  }).catch(() => {
    return ctx.reply(ack)
  })

  return true
}
