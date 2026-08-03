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
import { storagePathToNormalizedDataUri } from '../fal/client.mjs'
import {
  downloadImageArtifactToStorage,
  uploadImageArtifact,
} from '../image-artifact.mjs'
import { resolveXaiImageRequest } from '../image-resolution-contract.mjs'
import {
  allowPaidGarmentPrepCleanup,
  assertStudioRunPaidAttempt,
  requiresStudioRunPaidAttemptAuthorization,
  studioRunProviderMaxAttempts,
} from '../studio-run-authorize.mjs'

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
  if (resolution != null || aspectRatio != null) {
    resolveXaiImageRequest({ resolution, aspectRatio })
  }
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

export function validateXaiReferenceContract(refPaths, contract) {
  const bindings = Array.isArray(contract?.bindings) ? contract.bindings : []
  if (!bindings.length) return bindings
  if (bindings.length !== refPaths.length) {
    throw new Error(`xai reference contract mismatch: expected ${bindings.length}, queued ${refPaths.length}`)
  }
  for (let i = 0; i < bindings.length; i++) {
    if (bindings[i]?.path !== refPaths[i]) throw new Error(`xai reference contract order mismatch at ${i + 1}`)
  }
  return bindings
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

export async function saveXaiImage(supabase, image, pendingActionId, {
  suffix = '',
  model,
  requestedTier,
  requestedAspectRatio,
  validationContract,
  fetchImpl = fetch,
} = {}) {
  const storageBasePath = `generated/studio-${pendingActionId}${suffix ? `-${suffix}` : ''}`
  if (image.kind === 'url') {
    return downloadImageArtifactToStorage({
      supabase,
      outputUrl: image.value,
      storageBasePath,
      fetchImpl,
      kind: 'original',
      requestedTier,
      requestedAspectRatio,
      provider: 'xai',
      model,
      contract: validationContract,
    })
  }
  const buf = Buffer.from(image.value, 'base64')
  return uploadImageArtifact({
    supabase,
    buffer: buf,
    storageBasePath,
    kind: 'original',
    requestedTier,
    requestedAspectRatio,
    provider: 'xai',
    model,
    contract: validationContract,
  })
}

/**
 * Reference preparation per role (CS13.2 — garment-fidelity fix, owner live
 * test 2026-07-24: raw supplier photos made Grok invent garments):
 *  - 'garment' + SINGLE-person job → white-flattened garment cutout from the
 *    supplier photo (same free, kv-cached prep the FASHN chains use). Family
 *    pair jobs keep the RAW supplier photo — different-dress sets (মা+মেয়ে)
 *    need every piece visible.
 *  - 'person' → dark-plate cleanup (reseller model photos carry text plates).
 * Both fail OPEN to the raw image — prep must never block a paid run.
 */
async function prepareReferencePath({
  supabase,
  path,
  role,
  isFamilyPair,
  pendingActionId,
  logCost,
  allowPaidCleanup,
}) {
  try {
    if (role === 'garment' && !isFamilyPair) {
      const { prepSupplierPhoto } = await import('../garment-prep.mjs')
      const prep = await prepSupplierPhoto({
        supabase,
        imagePath: path,
        pendingActionId,
        logCost,
        allowPaidCleanup,
      })
      if (prep?.adultGarmentPath) return prep.adultGarmentPath
      return path
    }
    if (role === 'person') {
      const { cleanModelPhoto } = await import('../photo-cleanup.mjs')
      return await cleanModelPhoto({ supabase, imagePath: path })
    }
  } catch (err) {
    console.warn(`[worker] xai ref prep failed open (${role} ${path}): ${err.message}`)
  }
  return path
}

export async function processXaiImagine({ supabase, pendingActionId, payload, logCost }) {
  const model = payload.xaiModel
  if (!XAI_ALLOWED_MODELS.includes(model)) throw new Error(`xai model not allowlisted: ${model}`)
  if (payload.referenceContract?.actualModel && payload.referenceContract.actualModel !== model) {
    throw new Error(`xai model snapshot mismatch: expected ${payload.referenceContract.actualModel}, queued ${model}`)
  }
  const op = payload.xaiOp === 'generate' ? 'generate' : 'edit'
  // Fail unsupported tier/aspect combinations before reference processing or
  // the synchronous paid request. There is no silent 4K→2K or 4:5→3:4 clamp.
  const imageRequest = resolveXaiImageRequest({
    resolution: payload.resolution,
    aspectRatio: payload.aspectRatio,
  })
  const refPaths = Array.isArray(payload.referenceImagePaths) ? payload.referenceImagePaths.slice() : []
  if (refPaths.length > 3) throw new Error(`xai edit takes at most 3 reference images; queued ${refPaths.length}`)
  if (op === 'edit' && refPaths.length === 0) throw new Error('xai edit job has no reference images')
  const refRoles = Array.isArray(payload.referenceRoles) ? payload.referenceRoles : []
  const contractBindings = validateXaiReferenceContract(refPaths, payload.referenceContract)
  const isFamilyPair = refRoles.filter((r) => r === 'person').length >= 2

  const referenceDataUris = []
  const preparedPaths = []
  for (let i = 0; i < refPaths.length; i++) {
    const prepared = await prepareReferencePath({
      supabase,
      path: refPaths[i],
      role: refRoles[i] ?? 'source',
      isFamilyPair,
      pendingActionId,
      logCost,
      allowPaidCleanup: allowPaidGarmentPrepCleanup(payload),
    })
    preparedPaths.push(prepared)
    referenceDataUris.push(await storagePathToNormalizedDataUri(supabase, prepared))
  }
  if (referenceDataUris.length !== refPaths.length) {
    throw new Error(`xai required reference transport mismatch: expected ${refPaths.length}, sent ${referenceDataUris.length}`)
  }

  const resolution = imageRequest.providerImageSize
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
      aspectRatio: imageRequest.requestedAspectRatio,
      resolution,
      n: 1,
    })
    const started = Date.now()
    if (requiresStudioRunPaidAttemptAuthorization(payload)) {
      await assertStudioRunPaidAttempt(pendingActionId, payload, qcAttempt ?? 1)
    }
    const result = await callXai(path, body, {
      maxRetries: studioRunProviderMaxAttempts(payload, 3),
    })
    const image = extractXaiImage(result)
    if (!image) throw new Error('xai: no image in response')
    const suffix = qcAttempt && qcAttempt > 1 ? `qc${qcAttempt}` : ''
    const original = await saveXaiImage(supabase, image, pendingActionId, {
      suffix,
      model,
      requestedTier: imageRequest.requestedTier,
      requestedAspectRatio: imageRequest.requestedAspectRatio,
      validationContract: imageRequest.validationContract,
    })
    totalCostUsd += costUsd
    void logCost({
      provider: 'xai',
      kind: 'image',
      units: {
        engine: 'xai_imagine',
        model,
        op,
        resolution,
        aspectRatio: imageRequest.requestedAspectRatio,
        referenceCount: referenceDataUris.length,
        qcAttempt: qcAttempt ?? 1,
      },
      costUsd,
      jobId: pendingActionId,
      dedupKey: `xai:${pendingActionId}:${qcAttempt ?? 1}`,
    })
    return { storagePath: original.storagePath, original, latencyMs: Date.now() - started }
  }

  const first = await runOnce(1)
  let paths = [first.storagePath]
  let lastMeta = first
  const artifactsByPath = new Map([[first.storagePath, first.original]])

  let qc = null
  try {
    const { effectiveQcLevel, fetchQcLevel, runImageQcLoop } = await import('../image-qc.mjs')
    const { getAppUrl, getInternalToken } = await import('../env.mjs')
    const configuredQcLevel = await fetchQcLevel(supabase)
    const qcLevel = effectiveQcLevel(configuredQcLevel, payload.pipelineMode)
    if (qcLevel !== 'off') {
      const qcResult = await runImageQcLoop({
        supabase,
        appUrl: getAppUrl(),
        token: getInternalToken(),
        qcLevel,
        initialPath: first.storagePath,
        productType: null,
        productImagePath: payload.productImagePath ?? null,
        personImagePath: payload.referenceContract?.bindings?.find((binding) => binding.role === 'person')?.path
          ?? payload.modelImagePath
          ?? null,
        surface: payload.studioMode === 'try_on' ? 'single_tryon' : undefined,
        pipelineMode: payload.pipelineMode,
        maxPaidGenerations: payload.studioPaidAttemptLimit,
        regenerate: async (fixHint, attemptNum) => {
          const retry = await runOnce(attemptNum, fixHint)
          paths.push(retry.storagePath)
          artifactsByPath.set(retry.storagePath, retry.original)
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
    if (payload.pipelineMode === 'production') throw err
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
    referenceReceipt: {
      version: 1,
      expectedCount: refPaths.length,
      sentCount: referenceDataUris.length,
      roles: contractBindings.length ? contractBindings.map((binding) => binding.role) : refRoles,
      sources: contractBindings.map((binding) => binding.source),
      prepared: preparedPaths.map((path, index) => path !== refPaths[index]),
      allRequiredSent: true,
    },
    qc,
    original: artifactsByPath.get(paths[0]) ?? lastMeta.original,
  }
}
