/**
 * Owner Sir-task intake — 20:30 Asia/Dhaka (Phase D).
 */
const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runOwnerTaskIntake({ bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || !bot) {
    return { dutyStatus: 'skipped', dutyDetail: 'Telegram bot/owner chat নেই' }
  }

  if (!APP_URL() || !INT()) {
    return { dutyStatus: 'skipped', dutyDetail: 'APP_URL or AGENT_INTERNAL_TOKEN missing' }
  }

  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/owner-task-intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT()}` },
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data.error ?? `HTTP ${res.status}`)
    }
    if (data.message === 'already_resolved') {
      return { dutyStatus: 'skipped', dutyDetail: 'intake already resolved today' }
    }
    console.log(`[owner-task-intake] sent streak=${data.streak ?? 0}`)
    return { dutyStatus: 'done', dutyDetail: `Sir-task intake sent (streak ${data.streak ?? 0})` }
  } catch (e) {
    console.error('[owner-task-intake] failed:', e.message)
    return { dutyStatus: 'failed', dutyDetail: e.message }
  }
}
