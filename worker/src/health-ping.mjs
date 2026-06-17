/**
 * Ping app internal health every 5 min.
 * On failure → direct ntfy CRITICAL (bypass app).
 */
import { sendNtfy } from './notify/ntfy.mjs'
import { captureWorkerError } from './sentry.mjs'

const APP_URL = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

let lastAlertAt = 0
const ALERT_COOLDOWN_MS = 10 * 60 * 1000

export function startHealthPingLoop(intervalMs = 5 * 60 * 1000) {
  async function ping() {
    try {
      const res = await fetch(`${APP_URL()}/api/assistant/internal/health`, {
        headers: { Authorization: `Bearer ${INT_TOKEN()}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) return

      const now = Date.now()
      if (now - lastAlertAt < ALERT_COOLDOWN_MS) return
      lastAlertAt = now

      const logMsg = `App health check failed: HTTP ${res.status}. URL: ${APP_URL()}/api/assistant/internal/health`
      console.error(`[health-ping] ${logMsg}`)
      captureWorkerError(new Error(logMsg), 'worker.app_health_failed', { status: res.status })

      const ntfyMsg = `App health check failed: HTTP ${res.status}. Internal health endpoint unreachable.`
      await sendNtfy('critical', 'App down', ntfyMsg, 'urgent')
    } catch (err) {
      const now = Date.now()
      if (now - lastAlertAt < ALERT_COOLDOWN_MS) return
      lastAlertAt = now

      console.error(`[health-ping] App health unreachable: ${err.message}`)
      captureWorkerError(err, 'worker.app_health_unreachable')
      const ntfyErr = `App health unreachable: ${err.message?.replace(/https?:\/\/[^\s]+/g, '[redacted]')}`
      await sendNtfy('critical', 'App down', ntfyErr, 'urgent')
    }
  }

  void ping()
  return setInterval(ping, intervalMs)
}
