/**
 * ALMA Browser Worker — separate PM2 process for Phase A browser-agent tasks.
 *
 * Isolated from the main alma-agent-worker so Playwright/Chromium memory and
 * crashes never affect the core job/Telegram loop. Consumes the 'browser-task'
 * BullMQ queue (the main worker enqueues approved browser_action jobs there) and
 * reports results back via the same /api/assistant/internal/job-result endpoint.
 */

import '../env-bootstrap.mjs'
import { Worker } from 'bullmq'
import { getAppUrl, getInternalToken } from '../env.mjs'
import { runBrowserTask } from './runner.mjs'

// Phase 55 — the autonomous browser runs in an ISOLATED profile/process
// (this dedicated PM2 service + fresh ephemeral Playwright context per task;
// the supervised owner-Chrome companion is a separate mode entirely). The
// security quarantine is honoured before every task: after a critical
// incident the app flips agent_kv_settings['security_quarantine'] and this
// worker refuses new tasks until the owner clears it.
async function isSecurityQuarantined() {
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/health?check=security_quarantine`, {
      headers: { Authorization: `Bearer ${getInternalToken()}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return true // fail closed — can't verify security state
    const body = await res.json().catch(() => null)
    return body?.securityQuarantine === true
  } catch {
    return true // fail closed
  }
}

const required = ['REDIS_URL', 'APP_URL', 'AGENT_INTERNAL_TOKEN']
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[browser-worker] Missing required env var: ${key}`)
    process.exit(1)
  }
}

const connection = { url: process.env.REDIS_URL }
const MAX_JOB_RESULT_RETRIES = 3

async function callJobResult(pendingActionId, status, data, error, attempt = 0) {
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/job-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getInternalToken()}`,
      },
      body: JSON.stringify({ pendingActionId, status, data, error }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[browser-worker] job-result HTTP ${res.status}: ${body.slice(0, 200)}`)
      if (attempt + 1 < MAX_JOB_RESULT_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        return callJobResult(pendingActionId, status, data, error, attempt + 1)
      }
    }
  } catch (err) {
    console.error('[browser-worker] job-result error:', err.message)
    if (attempt + 1 < MAX_JOB_RESULT_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      return callJobResult(pendingActionId, status, data, error, attempt + 1)
    }
  }
}

const worker = new Worker(
  'browser-task',
  async (job) => {
    const { pendingActionId, payload } = job.data ?? {}
    if (!pendingActionId) {
      console.warn('[browser-worker] job with no pendingActionId — skipping')
      return
    }
    console.log(`[browser-worker] running task ${pendingActionId}: ${String(payload?.goal ?? '').slice(0, 80)}`)
    if (await isSecurityQuarantined()) {
      await callJobResult(pendingActionId, 'failed', undefined, 'security_quarantine — autonomous browser paused until the owner clears the incident')
      console.warn(`[browser-worker] task ${pendingActionId} refused — security quarantine active (or unverifiable, fail closed)`)
      return
    }
    try {
      const result = await runBrowserTask(payload ?? {})
      if (result.ok) {
        await callJobResult(pendingActionId, 'success', result)
        console.log(`[browser-worker] task ${pendingActionId} done (${result.log.length} steps)`)
      } else {
        await callJobResult(pendingActionId, 'failed', result, result.error || 'browser_task_failed')
        console.error(`[browser-worker] task ${pendingActionId} failed: ${result.error}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await callJobResult(pendingActionId, 'failed', undefined, msg)
      console.error(`[browser-worker] task ${pendingActionId} threw: ${msg}`)
    }
  },
  { connection, concurrency: 1, lockDuration: 2 * 60 * 1000 },
)

worker.on('failed', (job, err) => {
  console.error(`[browser-worker] job ${job?.id} failed:`, err?.message)
})

console.log('[browser-worker] started — consuming "browser-task" queue')

async function shutdown() {
  console.log('[browser-worker] shutting down…')
  await worker.close().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
