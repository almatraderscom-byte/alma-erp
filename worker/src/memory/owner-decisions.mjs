/**
 * Fetch recent owner-decision memories from Vercel memory-search API.
 */

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function fetchOwnerDecisions() {
  if (!APP_URL() || !INT()) return []
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/memory-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT()}` },
      body: JSON.stringify({
        query: 'staff task proposal preference decision owner directive',
        scope: 'business',
        limit: 8,
        metadataType: 'owner_decision',
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return data.memories ?? []
  } catch (err) {
    console.warn('[owner-decisions] fetch failed:', err instanceof Error ? err.message : err)
    return []
  }
}
