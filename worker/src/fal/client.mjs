/**
 * CS5 — durable Fal queue client (submit / status / result / cancel) with
 * persisted request state so a worker restart NEVER duplicates a paid
 * generation. Foundation only in CS5: adapters (CS6 VTON, CS7 FLUX Fill)
 * build on this.
 *
 * Durability contract (roadmap §5.2):
 *  - request_id is persisted to agent_kv_settings IMMEDIATELY after submit;
 *  - on restart, the same (endpointId + inputFingerprint) resumes the SAME
 *    paid request instead of re-submitting;
 *  - a failed result download/callback keeps the state row so retrieval can
 *    be retried later — it never triggers a new paid submit;
 *  - only explicitly transient failures (network / 408 / 429 / 5xx) are
 *    retried, with bounded backoff;
 *  - callers clear the state row ONLY after the artifact has landed in
 *    agent-files storage.
 */

const QUEUE_BASE = 'https://queue.fal.run'

/**
 * Server-side endpoint allowlist — mirrors ALLOWED_FAL_ENDPOINTS in
 * src/lib/creative-studio/provider-registry.ts (keep in sync). Client-supplied
 * strings must never reach Fal without passing this gate.
 */
export const ALLOWED_FAL_ENDPOINTS = [
  'fal-ai/fashn/tryon/v1.6',
  'fal-ai/cat-vton',
  'fal-ai/flux-pro/v1/fill',
]

export function assertAllowedFalEndpoint(endpointId) {
  if (!ALLOWED_FAL_ENDPOINTS.includes(endpointId)) {
    throw new Error(`fal endpoint not allowlisted: ${endpointId}`)
  }
}

function getFalKey() {
  const key = process.env.FAL_KEY?.trim()
  if (!key) throw new Error('FAL_KEY not configured on worker')
  return key
}

/**
 * Queue status/result URLs live under the app id (first two path segments),
 * not the full endpoint path: submitting to fal-ai/flux-pro/v1/fill polls at
 * fal-ai/flux-pro/requests/<id>/status. Prefer the URLs Fal returns on submit;
 * this derivation is the fallback for resumed requests.
 */
export function falAppBase(endpointId) {
  const segments = endpointId.split('/').filter(Boolean)
  return segments.slice(0, 2).join('/')
}

function authHeaders() {
  return { Authorization: `Key ${getFalKey()}`, 'Content-Type': 'application/json' }
}

function isTransientStatus(httpStatus) {
  return httpStatus === 408 || httpStatus === 429 || httpStatus >= 500
}

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const body = await res.json().catch(() => ({}))
  return { res, body }
}

/**
 * Submit a job to the Fal queue. Returns { requestId, statusUrl, responseUrl,
 * cancelUrl } — persist the requestId before doing anything else.
 */
export async function falSubmit(endpointId, input, { fetchImpl = fetch } = {}) {
  assertAllowedFalEndpoint(endpointId)
  const { res, body } = await fetchJson(
    fetchImpl,
    `${QUEUE_BASE}/${endpointId}`,
    { method: 'POST', headers: authHeaders(), body: JSON.stringify(input) },
    30_000,
  )
  if (!res.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body).slice(0, 300)
    const err = new Error(`fal submit ${res.status}: ${detail}`)
    err.transient = isTransientStatus(res.status)
    throw err
  }
  const requestId = body?.request_id
  if (!requestId) throw new Error('fal submit: missing request_id in response')
  return {
    requestId,
    statusUrl: body.status_url ?? `${QUEUE_BASE}/${falAppBase(endpointId)}/requests/${requestId}/status`,
    responseUrl: body.response_url ?? `${QUEUE_BASE}/${falAppBase(endpointId)}/requests/${requestId}`,
    cancelUrl: body.cancel_url ?? `${QUEUE_BASE}/${falAppBase(endpointId)}/requests/${requestId}/cancel`,
  }
}

/** @returns {Promise<{status: string, queuePosition?: number}>} */
export async function falStatus(endpointId, requestId, { fetchImpl = fetch, statusUrl } = {}) {
  assertAllowedFalEndpoint(endpointId)
  const url = statusUrl ?? `${QUEUE_BASE}/${falAppBase(endpointId)}/requests/${requestId}/status`
  const { res, body } = await fetchJson(fetchImpl, url, { headers: authHeaders() }, 20_000)
  if (!res.ok) {
    const err = new Error(`fal status ${res.status}`)
    err.transient = isTransientStatus(res.status)
    throw err
  }
  return { status: body?.status ?? 'UNKNOWN', queuePosition: body?.queue_position }
}

/** Fetch the finished payload. NEVER resubmit when this fails — retry retrieval. */
export async function falResult(endpointId, requestId, { fetchImpl = fetch, responseUrl } = {}) {
  assertAllowedFalEndpoint(endpointId)
  const url = responseUrl ?? `${QUEUE_BASE}/${falAppBase(endpointId)}/requests/${requestId}`
  const { res, body } = await fetchJson(fetchImpl, url, { headers: authHeaders() }, 60_000)
  if (!res.ok) {
    const err = new Error(`fal result ${res.status}`)
    err.transient = isTransientStatus(res.status)
    throw err
  }
  return body
}

/** Best-effort cancel (Fal honours it only while queued). */
export async function falCancel(endpointId, requestId, { fetchImpl = fetch, cancelUrl } = {}) {
  assertAllowedFalEndpoint(endpointId)
  const url = cancelUrl ?? `${QUEUE_BASE}/${falAppBase(endpointId)}/requests/${requestId}/cancel`
  const { res } = await fetchJson(fetchImpl, url, { method: 'PUT', headers: authHeaders() }, 20_000)
  return res.ok
}

// ── shared image plumbing (CS6) ──────────────────────────────────────────────

/**
 * Download an agent-files object and return it as a data URI, normalized for
 * VTON input: EXIF orientation baked in and longest side capped (default
 * 2048px) WITHOUT changing aspect ratio — person proportions stay intact.
 * Falls back to the raw bytes if sharp fails (e.g. exotic format).
 */
export async function storagePathToNormalizedDataUri(supabase, path, { maxSide = 2048, format = 'jpeg' } = {}) {
  const { data, error } = await supabase.storage.from('agent-files').download(path)
  if (error || !data) throw new Error(`download failed: ${path}`)
  const raw = Buffer.from(await data.arrayBuffer())
  try {
    const sharp = (await import('sharp')).default
    const pipeline = sharp(raw)
      .rotate() // apply EXIF orientation (iPhone photos)
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    // PNG for masks/precision bases (lossless, no jpeg edge bleed); JPEG default.
    const normalized = format === 'png'
      ? await pipeline.png().toBuffer()
      : await pipeline.jpeg({ quality: 92 }).toBuffer()
    return `data:image/${format === 'png' ? 'png' : 'jpeg'};base64,${normalized.toString('base64')}`
  } catch {
    const mime = data.type || 'image/jpeg'
    return `data:${mime};base64,${raw.toString('base64')}`
  }
}

/** Raw storage bytes (no normalization) — for pixel-exact composite work. */
export async function storagePathToBuffer(supabase, path) {
  const { data, error } = await supabase.storage.from('agent-files').download(path)
  if (error || !data) throw new Error(`download failed: ${path}`)
  return Buffer.from(await data.arrayBuffer())
}

/** Download a finished Fal output URL into agent-files storage. */
export async function downloadFalOutputToStorage(supabase, outputUrl, pendingActionId, suffix = '') {
  const res = await fetch(outputUrl, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`fal output download HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type') ?? 'image/png'
  const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png'
  const storagePath = `generated/studio-${pendingActionId}${suffix ? `-${suffix}` : ''}.${ext}`
  const { error } = await supabase.storage.from('agent-files').upload(storagePath, buf, {
    contentType,
    upsert: true,
  })
  if (error) throw new Error(`upload failed: ${error.message}`)
  return storagePath
}

/** First image URL out of the differing Fal result shapes ({image} vs {images:[]}). */
export function extractFalImageUrl(payload) {
  return payload?.image?.url ?? payload?.images?.[0]?.url ?? null
}

// ── CS12: model-specific kill switch (owner-tunable, no redeploy) ────────────

/** kv `cs_engine_kill:<engineId>` === '1' ⇒ jobs on this engine must refuse. */
export async function isEngineKilled(supabase, engineId) {
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', `cs_engine_kill:${engineId}`)
      .maybeSingle()
    return data?.value?.trim() === '1'
  } catch {
    return false // kill lookup failure must not block normal work
  }
}

// ── durable request state (agent_kv_settings) ────────────────────────────────

const stateKey = (pendingActionId) => `fal_request:${pendingActionId}`

/**
 * @typedef {object} FalJobState
 * @property {string} endpointId
 * @property {string} requestId
 * @property {string} submittedAt ISO timestamp
 * @property {string} inputFingerprint sha256 of endpoint+input
 * @property {number} attempt paid-submit count (1 = first and normally only)
 * @property {string} [statusUrl]
 * @property {string} [responseUrl]
 * @property {string} [cancelUrl]
 */

/** @returns {Promise<FalJobState|null>} */
export async function loadFalRequestState(supabase, pendingActionId) {
  const { data } = await supabase
    .from('agent_kv_settings')
    .select('value')
    .eq('key', stateKey(pendingActionId))
    .maybeSingle()
  if (!data?.value) return null
  try {
    const parsed = JSON.parse(data.value)
    return parsed && typeof parsed === 'object' && parsed.requestId ? parsed : null
  } catch {
    return null
  }
}

/** @param {FalJobState} state */
export async function saveFalRequestState(supabase, pendingActionId, state) {
  const { error } = await supabase
    .from('agent_kv_settings')
    .upsert({ key: stateKey(pendingActionId), value: JSON.stringify(state) }, { onConflict: 'key' })
  if (error) throw new Error(`fal state persist failed: ${error.message}`)
}

/** Call ONLY after the output artifact has landed in agent-files storage. */
export async function clearFalRequestState(supabase, pendingActionId) {
  await supabase.from('agent_kv_settings').delete().eq('key', stateKey(pendingActionId))
}

// ── durable run loop ─────────────────────────────────────────────────────────

const TERMINAL_OK = 'COMPLETED'
const TERMINAL_FAIL = new Set(['FAILED', 'ERROR', 'CANCELLED'])

/**
 * Submit-or-resume a Fal queue job and return its finished payload.
 *
 * Restart-safe: if a persisted state row matches this endpoint+fingerprint,
 * the existing paid request is resumed (no second submit). The state row is
 * intentionally NOT cleared here — the caller clears it after the artifact is
 * safely in storage, so a crashed download also resumes without re-paying.
 *
 * @param {object} args
 * @param {import('@supabase/supabase-js').SupabaseClient} args.supabase
 * @param {string} args.pendingActionId
 * @param {string} args.endpointId allowlisted Fal endpoint id
 * @param {object} args.input exact Fal payload
 * @param {string} args.inputFingerprint from falInputFingerprint()
 * @param {number} [args.maxMs] total poll budget
 * @param {number} [args.intervalMs] poll interval
 * @param {number} [args.maxTransientRetries] bounded retry count for transient poll errors
 * @param {typeof fetch} [args.fetchImpl]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @returns {Promise<{ requestId: string, payload: object, latencyMs: number, resumed: boolean }>}
 */
export async function runFalQueueJob({
  supabase,
  pendingActionId,
  endpointId,
  input,
  inputFingerprint,
  maxMs = 300_000,
  intervalMs = 3_000,
  maxTransientRetries = 5,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  assertAllowedFalEndpoint(endpointId)
  if (!inputFingerprint) throw new Error('inputFingerprint required for durable fal job')

  const started = Date.now()
  let state = await loadFalRequestState(supabase, pendingActionId)
  let resumed = false

  if (state && state.endpointId === endpointId && state.inputFingerprint === inputFingerprint) {
    resumed = true
    console.log(`[fal] ${pendingActionId} — resuming request ${state.requestId} (no new paid submit)`)
  } else {
    if (state) {
      // Different input than the persisted request — the old row is stale
      // (e.g. owner retried with new images). Drop it, then submit fresh.
      console.warn(`[fal] ${pendingActionId} — stale state (fingerprint mismatch), submitting fresh`)
      await clearFalRequestState(supabase, pendingActionId)
    }
    const sub = await falSubmit(endpointId, input, { fetchImpl })
    state = {
      endpointId,
      requestId: sub.requestId,
      submittedAt: new Date().toISOString(),
      inputFingerprint,
      attempt: 1,
      statusUrl: sub.statusUrl,
      responseUrl: sub.responseUrl,
      cancelUrl: sub.cancelUrl,
    }
    // Persist BEFORE the first poll — a crash after submit must not re-pay.
    await saveFalRequestState(supabase, pendingActionId, state)
  }

  let transientLeft = maxTransientRetries
  while (Date.now() - started < maxMs) {
    let st
    try {
      st = await falStatus(endpointId, state.requestId, { fetchImpl, statusUrl: state.statusUrl })
    } catch (err) {
      if (err.transient !== false && transientLeft > 0) {
        transientLeft -= 1
        await sleep(intervalMs * (maxTransientRetries - transientLeft))
        continue
      }
      throw err
    }
    transientLeft = maxTransientRetries

    if (st.status === TERMINAL_OK) {
      const payload = await falResult(endpointId, state.requestId, {
        fetchImpl,
        responseUrl: state.responseUrl,
      })
      return { requestId: state.requestId, payload, latencyMs: Date.now() - started, resumed }
    }
    if (TERMINAL_FAIL.has(st.status)) {
      // Generation itself failed on Fal's side — the request is dead, a fresh
      // submit is legitimate next time.
      await clearFalRequestState(supabase, pendingActionId)
      throw new Error(`fal job ${st.status.toLowerCase()}: ${endpointId} ${state.requestId}`)
    }
    await sleep(intervalMs)
  }
  throw new Error(`fal job timed out after ${maxMs}ms: ${endpointId} ${state.requestId} (state kept for resume)`)
}
