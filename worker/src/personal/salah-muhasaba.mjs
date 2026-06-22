/**
 * Nightly salah muhasaba trigger — ~22:30 Asia/Dhaka.
 * POSTs to the app's internal route which sends the reflection + sets the pending marker.
 */
const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runSalahMuhasaba({ bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || !bot) {
    return { dutyStatus: 'skipped', dutyDetail: 'Telegram bot/owner chat নেই' }
  }
  if (!APP_URL() || !INT()) {
    return { dutyStatus: 'skipped', dutyDetail: 'APP_URL or AGENT_INTERNAL_TOKEN missing' }
  }

  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/salah-muhasaba`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT()}` },
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    if (data.detail === 'already_resolved' || data.detail === 'already_pending') {
      return { dutyStatus: 'skipped', dutyDetail: data.detail }
    }
    console.log(`[salah-muhasaba] sent (${data.detail ?? 'ok'})`)
    return { dutyStatus: 'done', dutyDetail: `muhasaba sent (${data.detail ?? 'ok'})` }
  } catch (e) {
    console.error('[salah-muhasaba] failed:', e.message)
    return { dutyStatus: 'failed', dutyDetail: e.message }
  }
}
