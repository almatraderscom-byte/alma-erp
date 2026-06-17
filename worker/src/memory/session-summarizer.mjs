/**
 * Finds owner chat sessions that have ENDED (no new message for 30+ min)
 * and not yet summarized, then asks the agent API to extract key points.
 */
const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runSessionSummarizer() {
  if (!APP_URL() || !INT()) return
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/summarize-ended-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT()}` },
      body: JSON.stringify({ idleMinutes: 30, maxSessions: 5 }),
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.warn('[session-summarizer]', data.error ?? res.status)
      return
    }
    console.log(`[session-summarizer] summarized=${data.summarized ?? 0}`)
  } catch (e) {
    console.warn('[session-summarizer] failed:', e.message)
  }
}
