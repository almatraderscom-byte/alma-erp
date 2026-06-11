/**
 * Telegram dispatcher helpers.
 * Sends approval cards and staff messages; handles Phase 6 callbacks.
 */

let _bot = null
let _ownerChatId = null

export function setDispatcherBot(bot, ownerChatId) {
  _bot = bot
  _ownerChatId = String(ownerChatId)
}

/**
 * Sends an approval card to the owner.
 */
export async function sendTelegramApprovalCard({ message, pendingActionId, approveLabel = '✅ Approve', rejectLabel = '❌ Cancel' }) {
  if (!_bot || !_ownerChatId) {
    console.warn('[dispatcher] bot not initialized for approval card')
    return
  }

  const chunks = splitMessage(message)
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    await _bot.telegram.sendMessage(
      _ownerChatId,
      chunks[i],
      {
        parse_mode: 'Markdown',
        ...(isLast && pendingActionId ? {
          reply_markup: {
            inline_keyboard: [[
              { text: approveLabel, callback_data: `approve:${pendingActionId}` },
              { text: rejectLabel,  callback_data: `reject:${pendingActionId}`  },
            ]],
          },
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
