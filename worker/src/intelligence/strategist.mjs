const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

/** Daily cross-domain strategist — owner-gated move proposals. */
export async function runDailyStrategist() {
  if (!APP_URL() || !INT()) {
    console.warn('[strategist] APP_URL or AGENT_INTERNAL_TOKEN missing')
    return
  }
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/run-strategist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${INT()}` },
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.warn('[strategist] API failed:', res.status, data)
      return
    }
    console.log(
      `[strategist] moves=${data.moves ?? 0}${data.skipped ? ' (skipped)' : ''}`,
    )
  } catch (e) {
    console.warn('[strategist]', e.message)
  }
}
