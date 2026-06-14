import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

/**
 * Gentle evening personal check-in. Pulls open personal worries from memory
 * (scope=personal) to follow up, and asks about family contact today.
 */
export async function runPersonalCheckin({ bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || !bot) return
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/personal-checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT()}` },
      body: JSON.stringify({ kind: 'evening' }),
    })
    const data = await res.json().catch(() => ({}))
    const text = data.message ||
      'আসসালামু আলাইকুম স্যার। দিনটা কেমন গেল? পরিবারের সবার সাথে কথা হয়েছে আজ? কোনো কিছু মন খারাপ করছে কি না — বলতে পারেন, আমি আছি।'
    await sendMarkdownSafe(bot.telegram, ownerChatId, text)
    console.log('[personal-checkin] sent evening check-in')
  } catch (e) {
    console.error('[personal-checkin] failed:', e.message)
  }
}
