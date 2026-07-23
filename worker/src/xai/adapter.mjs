/**
 * CS13 — xAI Grok Imagine adapter (image generation + natural-language edit).
 *
 * Direct api.x.ai REST (Bearer XAI_API_KEY). Unlike Fal there is NO async
 * queue — one synchronous HTTP call returns the image, so no durable
 * request-state rows are needed. Retries are bounded and only for transient
 * failures (network / 408 / 429 / 5xx); a 4xx model refusal fails the job
 * cleanly. Result URLs from xAI are temporary — we download to agent-files
 * storage immediately, or use b64_json when returned.
 */
import {
  downloadFalOutputToStorage,
  storagePathToNormalizedDataUri,
} from '../fal/client.mjs'

const XAI_BASE = 'https://api.x.ai/v1'

export const XAI_ALLOWED_MODELS = ['grok-imagine-image-quality', 'grok-imagine-image']

function getXaiKey() {
  const key = process.env.XAI_API_KEY?.trim()
  if (!key) throw new Error('XAI_API_KEY not configured on worker')
  return key
}

function isTransientStatus(httpStatus) {
  return httpStatus === 408 || httpStatus === 429 || httpStatus >= 500
}

/** Build the exact request body (exported for contract tests). */
export function buildXaiRequest({ op, model, prompt, referenceDataUris = [], aspectRatio, resolution, n = 1 }) {
  if (!XAI_ALLOWED_MODELS.includes(model)) throw new Error(`xai model not allowlisted: ${model}`)
  if (!prompt?.trim()) throw new Error('xai: prompt required')
  const base = {
    model,
    prompt,
    n,
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
  }
  if (op === 'generate') {
    if (referenceDataUris.length > 0) throw new Error('xai generate takes no reference images')
    return { path: '/images/generations', body: base }
  }
  if (referenceDataUris.length < 1) throw new Error('xai edit needs at least one reference image')
  if (referenceDataUris.length > 3) throw new Error('xai edit takes at most 3 reference images')
  const refs = referenceDataUris.map((uri) => ({ url: uri, type: 'image_url' }))
  return {
    path: '/images/edits',
    // single reference uses `image`, multiple use `images` (docs.x.ai shapes)
    body: refs.length === 1 ? { ...base, image: refs[0] } : { ...base, images: refs },
  }
}

/** First image out of the response — b64 data URI or temporary URL. */
export function extractXaiImage(payload) {
  const item = payload?.data?.[0]
  if (!item) return null
  if (item.b64_json) return { kind: 'b64', value: item.b64_json }
  if (item.url) return { kind: 'url', value: item.url }
  return null
}

async function callXai(path, body, { fetchImpl = fetch, maxRetries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchImpl(`${XAI_BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getXaiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        const detail = typeof json?.error === 'string' ? json.error : JSON.stringify(json).slice(0, 300)
        const err = new Error(`xai ${path} ${res.status}: ${detail}`)
        err.transient = isTransientStatus(res.status)
        throw err
      }
      return json
    } catch (err) {
      lastErr = err
      const transient = err.transient !== false && (err.transient === true || err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ECONNRESET' || err.cause)
      if (!transient || attempt === maxRetries) throw err
      await sleep(2_000 * attempt)
    }
  }
  throw lastErr
}

async function saveXaiImage(supabase, image, pendingActionId, suffix = '') {
  if (image.kind === 'url') {
    return downloadFalOutputToStorage(supabase, image.value, pendingActionId, suffix)
  }
  const buf = Buffer.from(image.value, 'base64')
  const storagePath = `generated/studio-${pendingActionId}${suffix ? `-${suffix}` : ''}.png`
  const { error } = await supabase.storage.from('agent-files').upload(storagePath, buf, {
    contentType: 'image/png',
    upsert: true,
  })
  if (error) throw new Error(`upload failed: ${error.message}`)
  return storagePath
}

export async function processXaiImagine({ supabase, pendingActionId, payload, logCost }) {
  const model = XAI_ALLOWED_MODELS.includes(payload.xaiModel) ? payload.xaiModel : 'grok-imagine-image-quality'
  const op = payload.xaiOp === 'generate' ? 'generate' : 'edit'
  const refPaths = Array.isArray(payload.referenceImagePaths) ? payload.referenceImagePaths.slice(0, 3) : []
  if (op === 'edit' && refPaths.length === 0) throw new Error('xai edit job has no reference images')

  const referenceDataUris = []
  for (const p of refPaths) {
    referenceDataUris.push(await storagePathToNormalizedDataUri(supabase, p))
  }

  const resolution = payload.resolution === '1k' ? '1k' : '2k'
  const costUsd = resolution === '2k' ? 0.07 : 0.05
  let totalCostUsd = 0

  const runOnce = async (qcAttempt, fixHint) => {
    const prompt = fixHint
      ? `${payload.prompt}\n\nQC FIX (regeneration attempt ${qcAttempt}): ${fixHint}`
      : payload.prompt
    const { path, body } = buildXaiRequest({
      op,
      model,
      prompt,
      referenceDataUris,
      aspectRatio: payload.aspectRatio,
      resolution,
      n: 1,
    })
    const started = Date.now()
    const result = await callXai(path, body)
    const image = extractXaiImage(result)
    if (!image) throw new Error('xai: no image in response')
    const suffix = qcAttempt && qcAttempt > 1 ? `qc${qcAttempt}` : ''
    const storagePath = await saveXaiImage(supabase, image, pendingActionId, suffix)
    totalCostUsd += costUsd
    void logCost({
      provider: 'xai',
      kind: 'image',
      units: {
        engine: 'xai_imagine',
        model,
        op,
        resolution,
        aspectRatio: payload.aspectRatio ?? null,
        referenceCount: referenceDataUris.length,
        qcAttempt: qcAttempt ?? 1,
      },
      costUsd,
      jobId: pendingActionId,
      dedupKey: `xai:${pendingActionId}:${qcAttempt ?? 1}`,
    })
    return { storagePath, latencyMs: Date.now() - started }
  }

  const first = await runOnce(1)
  let paths = [first.storagePath]
  let lastMeta = first

  let qc = null
  try {
    const { fetchQcLevel, runImageQcLoop } = await import('../image-qc.mjs')
    const { getAppUrl, getInternalToken } = await import('../env.mjs')
    const qcLevel = await fetchQcLevel(supabase)
    if (qcLevel !== 'off') {
      const qcResult = await runImageQcLoop({
        supabase,
        appUrl: getAppUrl(),
        token: getInternalToken(),
        qcLevel,
        initialPath: first.storagePath,
        productType: null,
        productImagePath: payload.productImagePath ?? null,
        regenerate: async (fixHint, attemptNum) => {
          const retry = await runOnce(attemptNum, fixHint)
          paths.push(retry.storagePath)
          lastMeta = retry
          return retry.storagePath
        },
      })
      qc = qcResult.qc
      if (qcResult.storagePath && qcResult.storagePath !== paths[0]) {
        paths = [qcResult.storagePath, ...paths.filter((p) => p !== qcResult.storagePath)]
      }
    }
  } catch (err) {
    console.warn(`[worker] xai-imagine ${pendingActionId} — QC skipped: ${err.message}`)
  }

  return {
    storagePath: paths[0],
    allPaths: paths,
    provider: 'xai',
    xaiEngine: 'xai_imagine',
    xaiModel: model,
    xaiOp: op,
    latencyMs: lastMeta.latencyMs,
    costUsd: totalCostUsd,
    qc,
  }
}
