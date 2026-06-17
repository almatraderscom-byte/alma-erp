/**
 * Weekly taste distill — runs with reflection cadence.
 */
const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runTasteDistillJob() {
  if (!INT() || !APP_URL()) {
    console.warn('[taste-distill] missing APP_URL or AGENT_INTERNAL_TOKEN')
    return { skipped: true }
  }
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/taste-distill`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${INT()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ days: 14 }),
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json()
    console.log('[taste-distill]', JSON.stringify(data))
    return data
  } catch (e) {
    console.error('[taste-distill] failed:', e.message)
    return { error: e.message }
  }
}
