const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

/**
 * Finds outcomes whose measure_after has passed and are still pending,
 * fetches current metrics, judges results, saves learnings to memory.
 */
export async function runOutcomeMeasure() {
  if (!APP_URL() || !INT()) {
    console.warn('[outcome-measure] APP_URL or AGENT_INTERNAL_TOKEN missing')
    return
  }
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/measure-outcomes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${INT()}` },
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.warn('[outcome-measure] API failed:', res.status, data)
      return
    }
    console.log(`[outcome-measure] measured=${data.measured ?? 0}${data.errors?.length ? ` errors=${data.errors.length}` : ''}`)
  } catch (e) {
    console.warn('[outcome-measure]', e.message)
  }
}
