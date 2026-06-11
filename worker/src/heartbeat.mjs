/**
 * POST heartbeats to the app every 60s for watchdog monitoring.
 */

const APP_URL = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

const SERVICES = ['telegram-bot', 'schedulers', 'queue-consumer']

export function startHeartbeatLoop(opts = {}) {
  const {
    hasTelegram = false,
    hasSchedulers = false,
    intervalMs = 60_000,
  } = opts

  async function beat() {
    const services = ['queue-consumer']
    if (hasTelegram) services.push('telegram-bot')
    if (hasSchedulers) services.push('schedulers')

    try {
      const res = await fetch(`${APP_URL()}/api/assistant/internal/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INT_TOKEN()}`,
        },
        body: JSON.stringify({ services }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.warn(`[heartbeat] POST failed HTTP ${res.status}`)
      }
    } catch (err) {
      console.warn('[heartbeat] POST error:', err.message)
    }
  }

  void beat()
  return setInterval(beat, intervalMs)
}
