const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

/** Weekly self-reflection → owner-gated playbook proposals. */
export async function runWeeklyReflection() {
  if (!APP_URL() || !INT()) {
    console.warn('[reflection] APP_URL or AGENT_INTERNAL_TOKEN missing')
    return
  }
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/run-reflection`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${INT()}` },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.warn('[reflection] API failed:', res.status, data)
      return
    }
    console.log(
      `[reflection] proposed=${data.proposed ?? 0}${data.skipped ? ' (skipped)' : ''}`,
    )
  } catch (e) {
    console.warn('[reflection]', e.message)
  }
}
