/**
 * Runtime env accessors — never cache at module load (ESM import order safe).
 */
export function getAppUrl() {
  return String(process.env.APP_URL ?? '').replace(/\/$/, '')
}

export function getInternalToken() {
  return process.env.AGENT_INTERNAL_TOKEN ?? ''
}

/**
 * Where the worker EXECUTES a turn slice (VPS model-loop V1). When the
 * self-hosted engine is running beside this worker, WORKER_TURN_ENGINE_URL
 * (e.g. http://127.0.0.1:3100) removes the Vercel per-slice ceiling entirely;
 * unset, the worker keeps calling the Vercel app exactly as before. Only the
 * turn-slice callback uses this — every other worker call stays on APP_URL.
 */
export function getTurnEngineUrl() {
  const engine = String(process.env.WORKER_TURN_ENGINE_URL ?? '').trim().replace(/\/$/, '')
  return engine || getAppUrl()
}

/**
 * Upper bound on one turn-slice fetch. Must always exceed the executing
 * side's slice cap (Vercel maxDuration, or AGENT_WORKER_RERUN_CAP_MS on the
 * engine) or the WORKER becomes the ceiling: the old fixed 25-minute timeout
 * would have killed a 30-minute Vercel slice mid-stream. Default 65 minutes —
 * above the engine's 1-hour default slice cap.
 */
export function getTurnFetchTimeoutMs() {
  const raw = Number(process.env.WORKER_TURN_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 65 * 60 * 1000
}

export function getAppProtectionHeaders() {
  const bypass = String(process.env.WORKER_PREVIEW_E2E_BYPASS_SECRET ?? '').trim()
  return bypass ? { 'x-vercel-protection-bypass': bypass } : {}
}

export function getBotToken() {
  return process.env.ASSISTANT_BOT_TOKEN ?? ''
}

export function requireAppUrl(label = 'worker') {
  const url = getAppUrl()
  if (!url) throw new Error(`[${label}] APP_URL is not configured`)
  return url
}
