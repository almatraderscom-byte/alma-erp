/**
 * Telegram dispatcher helpers.
 * Sends approval cards and staff messages; handles Phase 6 callbacks.
 */

import { sendMarkdownSafe } from './markdown-safe.mjs'

let _bot = null
let _ownerChatId = null

export function setDispatcherBot(bot, ownerChatId) {
  _bot = bot
  _ownerChatId = String(ownerChatId)
}

/**
 * Sends an approval card to the owner.
 */
export async function sendTelegramApprovalCard({ message, pendingActionId, approveLabel = '✅ Approve', editLabel, rejectLabel = '❌ Cancel' }) {
  if (!_bot || !_ownerChatId) {
    console.warn('[dispatcher] bot not initialized for approval card')
    return
  }
  if (!pendingActionId) {
    console.error('[dispatcher] pendingActionId is missing — buttons will not be attached')
  }

  const chunks = splitMessage(message)
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    const buttons = [
      { text: approveLabel, callback_data: `approve:${pendingActionId}` },
      ...(editLabel ? [{ text: editLabel, callback_data: `edit:${pendingActionId}` }] : []),
      { text: rejectLabel,  callback_data: `reject:${pendingActionId}`  },
    ]
    await sendMarkdownSafe(
      _bot.telegram,
      _ownerChatId,
      chunks[i],
      {
        ...(isLast && pendingActionId ? {
          reply_markup: { inline_keyboard: [buttons] },
        } : {}),
      },
    )
  }
}

function splitMessage(text, limit = 4000) {
  const chunks = []
  let remaining = text
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt < limit * 0.5) splitAt = limit
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}
