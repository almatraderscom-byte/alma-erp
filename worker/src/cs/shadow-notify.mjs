/**
 * Shadow mode — send draft to Eyafi/owner with [📤 পাঠাও] [✏️] buttons.
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function notifyShadowDraft(bot, { draftId, pageId, psid, parts, customerName, pageName }) {
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n')
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID

  const displayName = customerName || psid
  const displayPage = pageName || pageId
  const nameLabel = customerName ? `👤 ${customerName}` : `👤 ${psid}`

  const body = `${nameLabel} — ${displayPage}\n\n📋 Draft:\n${text.slice(0, 1500)}`

  const keyboard = [[
    { text: '📤 পাঠাও', callback_data: `cs_send:${draftId}` },
    { text: '✏️ সম্পাদনা', callback_data: `cs_edit:${draftId}` },
  ]]

  // Eyafi first (content staff)
  const eyafiChat = process.env.CS_STAFF_EYAFI_CHAT_ID
  const targets = [eyafiChat, ownerChatId].filter(Boolean)

  for (const chatId of targets) {
    await sendMarkdownSafe(bot.telegram, chatId, body, {
      reply_markup: { inline_keyboard: keyboard },
    }).catch((err) => console.warn('[cs-shadow] notify failed:', err.message))
  }

  // Mark assigned staff on draft via API
  await fetch(`${APP_URL()}/api/assistant/internal/cs-shadow-draft`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN()}`,
    },
    body: JSON.stringify({ draftId, action: 'notified' }),
  }).catch(() => {})
}
