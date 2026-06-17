const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

/** Nightly business knowledge graph build — aggregates sales, staff, outcomes into structured facts. */
export async function runKnowledgeBuild() {
  if (!APP_URL() || !INT()) {
    console.warn('[knowledge-build] APP_URL or AGENT_INTERNAL_TOKEN missing')
    return
  }
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/build-knowledge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${INT()}` },
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.warn('[knowledge-build] API failed:', res.status, data)
      return
    }
    console.log(
      `[knowledge-build] factsWritten=${data.factsWritten ?? 0}${data.errors?.length ? ` errors=${data.errors.length}` : ''}`,
    )
  } catch (e) {
    console.warn('[knowledge-build]', e.message)
  }
}
