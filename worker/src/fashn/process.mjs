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
  downloadFashnOutputArtifactToStorage,
} from './client.mjs'
import { uploadImageArtifact } from '../image-artifact.mjs'
import { resolveDirectFashnImageRequest } from '../image-resolution-contract.mjs'

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
    resolution: fashnOptions?.resolution ?? '2k',
    aspectRatio: fashnOptions?.aspectRatio,
    generationMode: fashnOptions?.generationMode ?? 'balanced',
    numImages: 1,
    outputFormat: fashnOptions?.outputFormat ?? 'png',
  })
  await savePredictionId(supabase, pendingActionId, run.id)
  console.log(`[worker] fashn ${pendingActionId} — prediction ${run.id}`)
  return fashnPollUntilDone(run.id)
}

async function uploadFashnOutputs(
  supabase,
  outputs,
  pendingActionId,
  imageRequest,
  fashnModel,
  suffix = '',
) {
  const artifacts = []
  for (let i = 0; i < outputs.length; i++) {
    const url = outputs[i]
    const idxSuffix = `${suffix}${i ? `-${i}` : ''}`
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) continue
      const buf = Buffer.from(match[2], 'base64')
      artifacts.push(await uploadImageArtifact({
        supabase,
        buffer: buf,
        storageBasePath: `generated/studio-${pendingActionId}${idxSuffix ? `-${idxSuffix}` : ''}`,
        kind: 'original',
        requestedTier: imageRequest.requestedTier,
        requestedAspectRatio: imageRequest.requestedAspectRatio,
        provider: 'fashn',
        model: fashnModel,
        contract: imageRequest.validationContract,
      }))
    } else {
      artifacts.push(await downloadFashnOutputArtifactToStorage(
        supabase,
        url,
        pendingActionId,
        suffix ? `${suffix}-${i}` : i,
        {
          kind: 'original',
          requestedTier: imageRequest.requestedTier,
          requestedAspectRatio: imageRequest.requestedAspectRatio,
          provider: 'fashn',
          model: fashnModel,
          contract: imageRequest.validationContract,
        },
      ))
    }
  }
  return artifacts
}

function pickGarmentPath(rawInputs) {
  if (!rawInputs) return null
  for (const [key, val] of Object.entries(rawInputs)) {
    if (typeof val !== 'string' || !val) continue
    if (/garment|product|cloth|outfit|dress/i.test(key)) return val
  }
  return null
}

export async function processFashnImageGen({ supabase, pendingActionId, payload, logCost }) {
  const { fashnModel, fashnInputs, fashnOptions } = payload
  if (!fashnModel) throw new Error('fashnModel missing')
  const imageRequest = resolveDirectFashnImageRequest(fashnOptions?.resolution, {
    model: fashnModel,
    aspectRatio: fashnOptions?.aspectRatio,
  })
  const resolvedFashnOptions = {
    ...fashnOptions,
    resolution: imageRequest.providerImageSize,
    aspectRatio: imageRequest.providerAspectRatio,
  }

  const inputs = await resolveFashnImageInputs(supabase, fashnInputs)
  const done = await runOrResumeFashn(supabase, pendingActionId, fashnModel, inputs, resolvedFashnOptions)
  const outputs = done.output ?? []
  if (!outputs.length) throw new Error('FASHN empty output')

  const firstArtifacts = await uploadFashnOutputs(
    supabase,
    outputs,
    pendingActionId,
    imageRequest,
    fashnModel,
  )
  let paths = firstArtifacts.map((artifact) => artifact.storagePath)
  const artifactsByPath = new Map(firstArtifacts.map((artifact) => [artifact.storagePath, artifact]))

  const credits = imageRequest.requestedTier === '4k' ? 4 : imageRequest.requestedTier === '2k' ? 3 : 2
  void logCost({
    provider: 'fashn',
    kind: 'image',
    units: {
      model: fashnModel,
      resolution: imageRequest.requestedTier,
      aspectRatio: imageRequest.requestedAspectRatio,
      credits,
    },
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
      let regenAttempt = 0
      const qcResult = await runImageQcLoop({
        supabase,
        appUrl: getAppUrl(),
        token: getInternalToken(),
        qcLevel,
        initialPath: paths[0],
        productType,
        productImagePath,
        regenerate: async (_fixHint, attemptNum) => {
          regenAttempt = attemptNum
          // fresh prediction for the retry (don't resume the old one)
          await clearPredictionId(supabase, pendingActionId)
          const retry = await runOrResumeFashn(supabase, pendingActionId, fashnModel, inputs, resolvedFashnOptions)
          const retryOutputs = retry.output ?? []
          if (!retryOutputs.length) throw new Error('FASHN empty retry output')
          const retryArtifacts = await uploadFashnOutputs(
            supabase,
            retryOutputs,
            pendingActionId,
            imageRequest,
            fashnModel,
            `qc${attemptNum}`,
          )
          for (const artifact of retryArtifacts) {
            artifactsByPath.set(artifact.storagePath, artifact)
            if (!paths.includes(artifact.storagePath)) paths.push(artifact.storagePath)
          }
          return retryArtifacts[0].storagePath
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
          units: {
            model: fashnModel,
            resolution: imageRequest.requestedTier,
            aspectRatio: imageRequest.requestedAspectRatio,
            credits,
            qcRegens: regenAttempt,
          },
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
  return {
    storagePath: paths[0],
    allPaths: paths,
    provider: 'fashn',
    qc,
    original: artifactsByPath.get(paths[0]),
  }
}
