/**
 * Telegram inline buttons for reminders.
 */

import { getAppUrl, getInternalToken } from '../env.mjs'
async function updateReminder(id, action, minutes) {
  const res = await fetch(`${getAppUrl()}/api/assistant/internal/reminder-update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getInternalToken()}`,
    },
    body: JSON.stringify({ id, action, minutes }),
  })
  return res.json()
}

export async function handleReminderCallback(ctx, data) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || String(ctx.chat?.id) !== ownerChatId) return

  const parts = data.split(':')
  const action = parts[0]
  const id = parts[1]

  if (!id) return

  try {
    if (action === 'reminder_done') {
      await updateReminder(id, 'done')
      await ctx.answerCbQuery('✅ সম্পন্ন')
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    } else if (action === 'reminder_snooze') {
      const minutes = parseInt(parts[2] ?? '30', 10)
      await updateReminder(id, 'snooze', minutes)
      await ctx.answerCbQuery(`⏰ ${minutes} মিনিট পরে`)
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    } else if (action === 'reminder_cancel') {
      await updateReminder(id, 'cancel')
      await ctx.answerCbQuery('🗑️ বাতিল')
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {})
    }
  } catch (err) {
    await ctx.answerCbQuery(`সমস্যা: ${err.message}`).catch(() => {})
  }
}
