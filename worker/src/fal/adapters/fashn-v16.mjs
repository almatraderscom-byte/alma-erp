/**
 * CS6 — commercial Fal single-person try-on via fal-ai/fashn/tryon/v1.6.
 * Same durable contract as cat-vton: persisted request id, restart resume,
 * retrieval-only retry on download failure, fingerprint-salted QC regens.
 */
import {
  clearFalRequestState,
  downloadFalOutputToStorage,
  extractFalImageUrl,
  runFalQueueJob,
  storagePathToNormalizedDataUri,
} from '../client.mjs'
import { falInputFingerprint } from '../fingerprint.mjs'

export const FASHN_V16_ENDPOINT = 'fal-ai/fashn/tryon/v1.6'

const CATEGORIES = new Set(['tops', 'bottoms', 'one-pieces', 'auto'])
const MODES = new Set(['performance', 'balanced', 'quality'])

/**
 * Map the studio cloth placement + classified category onto FASHN v1.6 inputs.
 * FASHN's own `category` enum is tops/bottoms/one-pieces/auto — the owner's
 * cat-vton override still applies: lower→bottoms, upper/outer→tops,
 * overall→one-pieces; otherwise the classifier's suggestion, else auto.
 */
export function resolveFashnCategory({ clothType, fashnCategory }) {
  if (clothType === 'lower') return 'bottoms'
  if (clothType === 'upper' || clothType === 'outer') return 'tops'
  if (clothType === 'overall') return 'one-pieces'
  return CATEGORIES.has(fashnCategory) ? fashnCategory : 'auto'
}

/** Build the exact fal FASHN v1.6 payload (exported for contract tests). */
export function buildFashnV16Input({ modelDataUri, garmentDataUri, category, mode, seed, garmentPhotoType }) {
  if (!CATEGORIES.has(category)) throw new Error(`invalid category: ${category}`)
  return {
    model_image: modelDataUri,
    garment_image: garmentDataUri,
    category,
    mode: MODES.has(mode) ? mode : 'balanced',
    output_format: 'png',
    num_samples: 1,
    // supplier photos are worn (model/mannequin) — telling FASHN improves extraction
    ...(['model', 'flat-lay'].includes(garmentPhotoType) ? { garment_photo_type: garmentPhotoType } : {}),
    ...(Number.isFinite(seed) ? { seed } : {}),
  }
}

export async function processFashnV16({ supabase, pendingActionId, payload, logCost }) {
  const { productImagePath, modelImagePath } = payload
  if (!productImagePath || !modelImagePath) throw new Error('fashn-v16 needs productImagePath + modelImagePath')

  const [modelDataUri, garmentDataUri] = await Promise.all([
    storagePathToNormalizedDataUri(supabase, modelImagePath),
    storagePathToNormalizedDataUri(supabase, productImagePath),
  ])

  const category = resolveFashnCategory({
    clothType: payload.clothType,
    fashnCategory: payload.fashnCategory,
  })
  // fal lists FASHN v1.6 at a flat ~$0.075/generation
  const { calcFalFashnCostUsd } = await import('../../cost-log.mjs')
  const costUsd = calcFalFashnCostUsd(1)
  let totalCostUsd = 0

  const runOnce = async (qcAttempt) => {
    const input = buildFashnV16Input({
      modelDataUri,
      garmentDataUri,
      category,
      mode: payload.generationMode,
      seed: payload.seed,
      garmentPhotoType: payload.garmentPhotoType,
    })
    const fingerprint = falInputFingerprint(FASHN_V16_ENDPOINT, {
      modelImagePath,
      productImagePath,
      category,
      mode: input.mode,
      seed: input.seed ?? null,
      qcAttempt: qcAttempt ?? 1,
    })
    const out = await runFalQueueJob({
      supabase,
      pendingActionId,
      endpointId: FASHN_V16_ENDPOINT,
      input,
      inputFingerprint: fingerprint,
    })
    const url = extractFalImageUrl(out.payload)
    if (!url) throw new Error('fashn-v16: no image in fal result')
    const suffix = qcAttempt && qcAttempt > 1 ? `qc${qcAttempt}` : ''
    const storagePath = await downloadFalOutputToStorage(supabase, url, pendingActionId, suffix)
    await clearFalRequestState(supabase, pendingActionId)
    totalCostUsd += costUsd
    void logCost({
      provider: 'fal',
      kind: 'image',
      units: {
        engine: 'fal_fashn_v16',
        endpoint: FASHN_V16_ENDPOINT,
        requestId: out.requestId,
        category,
        mode: input.mode,
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
    console.warn(`[worker] fashn-v16 ${pendingActionId} — QC skipped: ${err.message}`)
  }

  return {
    storagePath: paths[0],
    allPaths: paths,
    provider: 'fal',
    falEngine: 'fal_fashn_v16',
    falEndpointId: FASHN_V16_ENDPOINT,
    requestId: lastMeta.requestId,
    seed: lastMeta.seed,
    latencyMs: lastMeta.latencyMs,
    costUsd: totalCostUsd,
    qc,
  }
}
