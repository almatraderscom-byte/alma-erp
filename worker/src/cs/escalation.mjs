/**
 * Shadow draft + handoff escalation ladder (10m / 15m / 25m).
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runCsEscalation(bot) {
  const res = await fetch(`${APP_URL()}/api/assistant/internal/cs-escalation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN()}`,
    },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    console.error('[cs-escalation] API failed', res.status)
    return
  }
  const data = await res.json()
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId) return

  for (const item of data.actions ?? []) {
    if (item.type === 'staff_reminder' && item.staffChatId) {
      await bot.telegram.sendMessage(item.staffChatId, item.message).catch(() => {})
    } else if (item.type === 'owner_escalation') {
      await sendMarkdownSafe(bot.telegram, ownerChatId, item.message, {
        reply_markup: item.draftId ? {
          inline_keyboard: [[
            { text: '📤 পাঠাও', callback_data: `cs_send:${item.draftId}` },
            { text: '✏️ সম্পাদনা', callback_data: `cs_edit:${item.draftId}` },
          ]],
        } : undefined,
      }).catch(() => {})
    } else if (item.type === 'owner_critical') {
      await sendMarkdownSafe(bot.telegram, ownerChatId, `🚨 ${item.message}`).catch(() => {})
    }
  }

  if (data.actions?.length) {
    console.log(`[cs-escalation] ${data.actions.length} action(s)`)
  }
}
