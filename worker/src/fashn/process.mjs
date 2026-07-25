/**
 * FASHN image generation for Creative Studio jobs.
 *
 * Hardening over the first version:
 *  - the FASHN prediction id is persisted to kv as soon as we have it, so a
 *    worker restart RESUMES polling the same prediction instead of paying for a
 *    brand-new render (the old code lost the in-flight prediction on restart);
 *  - a bounded QC loop (same gate as the Gemini path) re-runs FASHN when the
 *    designer score fails — best-effort, never blocks the real output.
 */
import {
  fashnRun,
  fashnPollUntilDone,
  fashnStatus,
  resolveFashnImageInputs,
  downloadFashnOutputToStorage,
} from './client.mjs'

const PRED_KEY = (id) => `cs_fashn_pred:${id}`

async function savePredictionId(supabase, pendingActionId, predictionId) {
  try {
    await supabase
      .from('agent_kv_settings')
      .upsert({ key: PRED_KEY(pendingActionId), value: predictionId }, { onConflict: 'key' })
  } catch {
    /* best-effort */
  }
}

async function loadPredictionId(supabase, pendingActionId) {
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', PRED_KEY(pendingActionId))
      .maybeSingle()
    return data?.value?.trim() || null
  } catch {
    return null
  }
}

async function clearPredictionId(supabase, pendingActionId) {
  try {
    await supabase.from('agent_kv_settings').delete().eq('key', PRED_KEY(pendingActionId))
  } catch {
    /* best-effort */
  }
}

/** Run (or resume) one FASHN prediction and return its completed status. */
async function runOrResumeFashn(supabase, pendingActionId, fashnModel, inputs, fashnOptions) {
  // Resume an in-flight prediction across a worker restart.
  const existing = await loadPredictionId(supabase, pendingActionId)
  if (existing) {
    try {
      const st = await fashnStatus(existing)
      if (st.status === 'completed') return st
      if (st.status !== 'failed') {
        console.log(`[worker] fashn ${pendingActionId} — resuming prediction ${existing}`)
        return fashnPollUntilDone(existing)
      }
    } catch {
      /* stale id — fall through to a fresh run */
    }
  }

  const run = await fashnRun(fashnModel, inputs, {
    prompt: fashnOptions?.prompt,
    aspectRatio: fashnOptions?.aspectRatio,
    resolution: fashnOptions?.resolution ?? '2k',
    generationMode: fashnOptions?.generationMode ?? 'balanced',
    seed: fashnOptions?.seed,
    numImages: 1,
    outputFormat: fashnOptions?.outputFormat ?? 'png',
  })
  await savePredictionId(supabase, pendingActionId, run.id)
  console.log(`[worker] fashn ${pendingActionId} — prediction ${run.id}`)
  return fashnPollUntilDone(run.id)
}

async function uploadFashnOutputs(supabase, outputs, pendingActionId, suffix = '') {
  const paths = []
  for (let i = 0; i < outputs.length; i++) {
    const url = outputs[i]
    const idxSuffix = `${suffix}${i ? `-${i}` : ''}`
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) continue
      const buf = Buffer.from(match[2], 'base64')
      const ext = match[1].includes('jpeg') ? 'jpg' : 'png'
      const storagePath = `generated/studio-${pendingActionId}${idxSuffix ? `-${idxSuffix}` : ''}.${ext}`
      await supabase.storage.from('agent-files').upload(storagePath, buf, {
        contentType: match[1],
        upsert: true,
      })
      paths.push(storagePath)
    } else {
      paths.push(await downloadFashnOutputToStorage(supabase, url, pendingActionId, suffix ? `${suffix}-${i}` : i))
    }
  }
  return paths
}

function pickGarmentPath(rawInputs) {
  if (!rawInputs) return null
  for (const [key, val] of Object.entries(rawInputs)) {
    if (typeof val !== 'string' || !val) continue
    if (/garment|product|cloth|outfit|dress/i.test(key)) return val
  }
  return null
}

const FASHN_IMAGE_INPUT_KEYS = new Set([
  'product_image',
  'model_image',
  'face_reference',
  'face_image',
  'image',
  'image_context',
  'mask',
])

export function validateFashnReferenceContract(rawInputs, contract) {
  if (!Array.isArray(contract?.bindings)) return
  const queuedPaths = Object.entries(rawInputs ?? {})
    .filter(([key, value]) => FASHN_IMAGE_INPUT_KEYS.has(key) && typeof value === 'string' && value)
    .map(([, value]) => value)
  const boundPaths = contract.bindings.map((binding) => binding.path)
  if (queuedPaths.length !== boundPaths.length) {
    throw new Error(`fashn reference contract mismatch: expected ${boundPaths.length}, queued ${queuedPaths.length}`)
  }
  for (const path of boundPaths) {
    if (!queuedPaths.includes(path)) throw new Error(`fashn reference contract missing: ${path}`)
  }
}

export function calculateFashnCredits(fashnOptions, rawInputs) {
  const resolution = ['1k', '2k', '4k'].includes(fashnOptions?.resolution) ? fashnOptions.resolution : '2k'
  const mode = ['fast', 'balanced', 'quality'].includes(fashnOptions?.generationMode)
    ? fashnOptions.generationMode
    : 'balanced'
  const credits = {
    fast: { '1k': 1, '2k': 2, '4k': 3 },
    balanced: { '1k': 2, '2k': 3, '4k': 4 },
    quality: { '1k': 3, '2k': 4, '4k': 5 },
  }[mode][resolution]
  return credits + (rawInputs?.face_reference ? 3 : 0)
}

export function extractFashnOutputs(output) {
  if (Array.isArray(output)) return output.filter((value) => typeof value === 'string' && value)
  if (Array.isArray(output?.images)) return output.images.filter((value) => typeof value === 'string' && value)
  return []
}

export async function processFashnImageGen({ supabase, pendingActionId, payload, logCost }) {
  const { fashnModel, fashnInputs, fashnOptions } = payload
  if (!fashnModel) throw new Error('fashnModel missing')

  validateFashnReferenceContract(fashnInputs, payload.referenceContract)
  const inputs = await resolveFashnImageInputs(supabase, fashnInputs)
  const done = await runOrResumeFashn(supabase, pendingActionId, fashnModel, inputs, fashnOptions)
  const outputs = extractFashnOutputs(done.output)
  if (!outputs.length) throw new Error('FASHN empty output')

  let paths = await uploadFashnOutputs(supabase, outputs, pendingActionId)

  const credits = calculateFashnCredits(fashnOptions, fashnInputs)
  void logCost({
    provider: 'fashn',
    kind: 'image',
    units: { model: fashnModel, resolution: fashnOptions?.resolution, credits },
    costUsd: credits * 0.075,
    jobId: pendingActionId,
    dedupKey: `fashn:${pendingActionId}`,
  })

  // ── Best-effort QC gate (same designer score as the Gemini path) ───────────
  let qc = null
  try {
    const { fetchQcLevel, runImageQcLoop } = await import('../image-qc.mjs')
    const { getAppUrl, getInternalToken } = await import('../env.mjs')
    const qcLevel = await fetchQcLevel(supabase)
    if (qcLevel !== 'off') {
      const productType = payload.contentPipeline?.productCode ?? null
      const productImagePath = pickGarmentPath(fashnInputs)
      const personImagePath = payload.referenceContract?.bindings?.find((binding) => binding.role === 'person')?.path ?? null
      let regenAttempt = 0
      const qcResult = await runImageQcLoop({
        supabase,
        appUrl: getAppUrl(),
        token: getInternalToken(),
        qcLevel,
        initialPath: paths[0],
        productType,
        productImagePath,
        personImagePath,
        regenerate: async (_fixHint, attemptNum) => {
          regenAttempt = attemptNum
          // fresh prediction for the retry (don't resume the old one)
          await clearPredictionId(supabase, pendingActionId)
          const retry = await runOrResumeFashn(supabase, pendingActionId, fashnModel, inputs, fashnOptions)
          const retryOutputs = extractFashnOutputs(retry.output)
          if (!retryOutputs.length) throw new Error('FASHN empty retry output')
          const retryPaths = await uploadFashnOutputs(supabase, retryOutputs, pendingActionId, `qc${attemptNum}`)
          return retryPaths[0]
        },
      })
      qc = qcResult.qc
      // Promote the QC-best image to be the primary output.
      if (qcResult.storagePath && qcResult.storagePath !== paths[0]) {
        paths = [qcResult.storagePath, ...paths.filter((p) => p !== qcResult.storagePath)]
      }
      if (regenAttempt) {
        void logCost({
          provider: 'fashn',
          kind: 'image',
          units: { model: fashnModel, resolution: fashnOptions?.resolution, credits, qcRegens: regenAttempt },
          costUsd: credits * 0.075 * regenAttempt,
          jobId: pendingActionId,
          dedupKey: `fashn:${pendingActionId}:qc`,
        })
      }
    }
  } catch (err) {
    console.warn(`[worker] fashn ${pendingActionId} — QC skipped: ${err.message}`)
  }

  await clearPredictionId(supabase, pendingActionId)
  const referenceReceipt = payload.referenceContract
    ? {
        version: 1,
        expectedCount: payload.referenceContract.bindings?.length ?? 0,
        sentCount: Object.keys(inputs).filter((key) =>
          ['product_image', 'model_image', 'face_reference', 'face_image', 'image', 'image_context', 'mask'].includes(key),
        ).length,
        roles: (payload.referenceContract.bindings ?? []).map((binding) => binding.role),
        allRequiredSent: true,
      }
    : undefined
  return {
    storagePath: paths[0],
    allPaths: paths,
    provider: 'fashn',
    imageModel: fashnModel,
    referenceReceipt,
    qc,
  }
}
