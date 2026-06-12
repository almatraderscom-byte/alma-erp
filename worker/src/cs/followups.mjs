/**
 * CS-2 — Process due follow-ups every 15 min (23h Meta window enforced in API).
 */
const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runCsFollowups() {
  const res = await fetch(`${APP_URL()}/api/assistant/internal/cs-followups`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN()}`,
    },
    body: JSON.stringify({ action: 'process' }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  console.log(`[cs-followups] sent=${data.sent ?? 0} expired=${data.expired ?? 0}`)
  return data
}
