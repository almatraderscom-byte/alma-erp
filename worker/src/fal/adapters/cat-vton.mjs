/**
 * CS6 — IDM-VTON-style single-person try-on via fal-ai/cat-vton (RESEARCH-ONLY,
 * owner opt-in). Person photo + garment photo + placement class → dressed shot.
 *
 * Durable: rides runFalQueueJob — request id persisted before polling, worker
 * restart resumes the SAME paid request, failed output download retries
 * retrieval without a new generation. QC regens salt the fingerprint so each
 * bounded retry is a deliberate new paid run, never an accidental one.
 */
import {
  clearFalRequestState,
  downloadFalOutputToStorage,
  extractFalImageUrl,
  runFalQueueJob,
  storagePathToNormalizedDataUri,
} from '../client.mjs'
import { falInputFingerprint } from '../fingerprint.mjs'

export const CAT_VTON_ENDPOINT = 'fal-ai/cat-vton'

const CLOTH_TYPES = new Set(['overall', 'upper', 'lower', 'outer'])

/** Build the exact cat-vton payload (exported for contract tests). */
export function buildCatVtonInput({ humanDataUri, garmentDataUri, clothType, numInferenceSteps, guidanceScale, seed }) {
  if (!CLOTH_TYPES.has(clothType)) throw new Error(`invalid cloth_type: ${clothType}`)
  return {
    human_image_url: humanDataUri,
    garment_image_url: garmentDataUri,
    cloth_type: clothType,
    num_inference_steps: Number.isFinite(numInferenceSteps) ? numInferenceSteps : 30,
    guidance_scale: Number.isFinite(guidanceScale) ? guidanceScale : 2.5,
    ...(Number.isFinite(seed) ? { seed } : {}),
  }
}

/** Research-only pricing has no published contract — owner-tunable kv, default $0.05 est. */
async function readIdmCostUsd(supabase) {
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', 'cs_idm_vton_cost_usd')
      .maybeSingle()
    const v = Number(data?.value)
    return Number.isFinite(v) && v >= 0 ? v : 0.05
  } catch {
    return 0.05
  }
}

export async function processCatVton({ supabase, pendingActionId, payload, logCost }) {
  const { productImagePath, modelImagePath, clothType } = payload
  if (!productImagePath || !modelImagePath) throw new Error('cat-vton needs productImagePath + modelImagePath')

  const [humanDataUri, garmentDataUri] = await Promise.all([
    storagePathToNormalizedDataUri(supabase, modelImagePath),
    storagePathToNormalizedDataUri(supabase, productImagePath),
  ])

  const costUsd = await readIdmCostUsd(supabase)
  let totalCostUsd = 0

  const runOnce = async (qcAttempt) => {
    const input = buildCatVtonInput({
      humanDataUri,
      garmentDataUri,
      clothType,
      numInferenceSteps: payload.numInferenceSteps,
      guidanceScale: payload.guidanceScale,
      seed: payload.seed,
    })
    // Fingerprint on storage paths + params (not the multi-MB data URIs); the
    // qcAttempt salt makes each bounded QC regen a distinct durable request.
    const fingerprint = falInputFingerprint(CAT_VTON_ENDPOINT, {
      modelImagePath,
      productImagePath,
      clothType,
      steps: input.num_inference_steps,
      guidance: input.guidance_scale,
      seed: input.seed ?? null,
      qcAttempt: qcAttempt ?? 1,
    })
    const out = await runFalQueueJob({
      supabase,
      pendingActionId,
      endpointId: CAT_VTON_ENDPOINT,
      input,
      inputFingerprint: fingerprint,
    })
    const url = extractFalImageUrl(out.payload)
    if (!url) throw new Error('cat-vton: no image in fal result')
    const suffix = qcAttempt && qcAttempt > 1 ? `qc${qcAttempt}` : ''
    const storagePath = await downloadFalOutputToStorage(supabase, url, pendingActionId, suffix)
    // Artifact landed — safe to clear the durable request row now.
    await clearFalRequestState(supabase, pendingActionId)
    totalCostUsd += costUsd
    void logCost({
      provider: 'fal',
      kind: 'image',
      units: {
        engine: 'fal_idm_vton',
        endpoint: CAT_VTON_ENDPOINT,
        requestId: out.requestId,
        clothType,
        steps: input.num_inference_steps,
        seed: input.seed ?? null,
        qcAttempt: qcAttempt ?? 1,
      },
      costUsd,
      jobId: pendingActionId,
      dedupKey: `fal:${pendingActionId}:${qcAttempt ?? 1}`,
    })
    return {
      storagePath,
      requestId: out.requestId,
      latencyMs: out.latencyMs,
      seed: out.payload?.seed ?? payload.seed ?? null,
    }
  }

  const first = await runOnce(1)
  let paths = [first.storagePath]
  let lastMeta = first

  // Best-effort bounded QC (same designer gate as the other engines).
  let qc = null
  try {
    const { fetchQcLevel, runImageQcLoop } = await import('../../image-qc.mjs')
    const { getAppUrl, getInternalToken } = await import('../../env.mjs')
    const qcLevel = await fetchQcLevel(supabase)
    if (qcLevel !== 'off') {
      const qcResult = await runImageQcLoop({
        supabase,
        appUrl: getAppUrl(),
        token: getInternalToken(),
        qcLevel,
        initialPath: first.storagePath,
        productType: null,
        productImagePath,
        regenerate: async (_fixHint, attemptNum) => {
          const retry = await runOnce(attemptNum)
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
    console.warn(`[worker] cat-vton ${pendingActionId} — QC skipped: ${err.message}`)
  }

  return {
    storagePath: paths[0],
    allPaths: paths,
    provider: 'fal',
    falEngine: 'fal_idm_vton',
    falEndpointId: CAT_VTON_ENDPOINT,
    requestId: lastMeta.requestId,
    seed: lastMeta.seed,
    latencyMs: lastMeta.latencyMs,
    costUsd: totalCostUsd,
    researchOnly: true,
    qc,
  }
}
