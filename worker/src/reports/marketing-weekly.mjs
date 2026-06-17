/**
 * Weekly marketing report — Sat 10:00 Dhaka (cron 0 4 * * 6 UTC).
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runMarketingWeekly({ bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId) {
    console.warn('[marketing-weekly] TELEGRAM_OWNER_CHAT_ID not set — skipped')
    return { dutyStatus: 'skipped', dutyDetail: 'No owner chat' }
  }

  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/marketing-report?days=7`, {
      headers: { Authorization: `Bearer ${INT()}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      console.warn('[marketing-weekly] API failed:', res.status)
      return { dutyStatus: 'failed', dutyDetail: `HTTP ${res.status}` }
    }
    const { report } = await res.json()
    const text = report || '📈 Marketing report — no content generated.'
    await sendMarkdownSafe(bot.telegram, ownerChatId, text)
    console.log('[marketing-weekly] sent to owner')
    return { dutyStatus: 'done', dutyDetail: 'Weekly marketing report sent' }
  } catch (e) {
    console.error('[marketing-weekly] failed:', e.message)
    return { dutyStatus: 'failed', dutyDetail: e.message }
  }
}
