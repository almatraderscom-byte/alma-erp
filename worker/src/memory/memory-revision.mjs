/**
 * Weekly memory revision — asks the app to review the agent's memory store,
 * list stale (old + unused) memories in a confirm card, and let the OWNER
 * decide what gets removed. Nothing is deleted without his approval; the
 * cleanup keeps retrieval sharp and memory cost from creeping up week over week.
 */
const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runMemoryRevision() {
  if (!APP_URL() || !INT()) return
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/memory-revision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT()}` },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.warn('[memory-revision]', data.error ?? res.status)
      return
    }
    if (data.skipped) {
      console.log(`[memory-revision] skipped — ${data.skipped}`)
    } else {
      console.log(`[memory-revision] candidates=${data.candidates ?? 0} total=${data.totalMemories ?? '?'}`)
    }
  } catch (e) {
    console.warn('[memory-revision] failed:', e.message)
  }
}
