/**
 * Durable local outbox for NGS post-call reports.
 *
 * The VPS filesystem survives process restarts, so a transcript is written with
 * owner-only permissions BEFORE the HTTP callback. Delivery is retried with
 * bounded backoff and the file is removed only after a 2xx acknowledgement.
 */
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_DIR = process.env.VOICE_CALL_REPORT_OUTBOX_DIR || './data/voice-call-reports'

const safeId = (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function persistCallReport(payload, dir = DEFAULT_DIR) {
  if (!payload?.callRecordId) throw new Error('missing_callRecordId')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${safeId(payload.callRecordId)}.json`)
  await writeFile(path, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
  return path
}

export async function deliverPersistedCallReport(payload, options = {}) {
  const appUrl = String(options.appUrl || process.env.APP_URL || '').replace(/\/$/, '')
  const token = String(options.token || process.env.AGENT_INTERNAL_TOKEN || '')
  const fetchImpl = options.fetchImpl || fetch
  const attempts = Math.max(1, Number(options.attempts || 6))
  const sleep = options.sleep || pause
  if (!appUrl || !token) throw new Error('report_delivery_unconfigured')

  let lastError = 'unknown'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(`${appUrl}/api/assistant/voice-call/relay-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) return { ok: true, status: res.status, attempt }
      const detail = await res.text().catch(() => '')
      lastError = `HTTP ${res.status}: ${detail.slice(0, 300)}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    if (attempt < attempts) await sleep(Math.min(60_000, 1_000 * 2 ** (attempt - 1)))
  }
  throw new Error(lastError)
}

export async function queueAndDeliverCallReport(payload, options = {}) {
  const dir = options.dir || DEFAULT_DIR
  const path = await persistCallReport(payload, dir)
  const delivered = await deliverPersistedCallReport(payload, options)
  await unlink(path).catch(() => {})
  return delivered
}

export async function drainCallReportOutbox(options = {}) {
  const dir = options.dir || DEFAULT_DIR
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  const results = []
  for (const name of files) {
    const path = join(dir, name)
    try {
      const payload = JSON.parse(await readFile(path, 'utf8'))
      const delivered = await deliverPersistedCallReport(payload, options)
      await unlink(path).catch(() => {})
      results.push({ name, ok: true, attempt: delivered.attempt })
    } catch (err) {
      results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}

