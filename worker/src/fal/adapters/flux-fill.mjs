/**
 * CS7 — FLUX.1 Pro Fill (fal-ai/flux-pro/v1/fill): masked precision edit.
 *
 * Mask contract (locked, see src/lib/creative-studio/mask-contract.ts):
 * white = edit, black = keep. The final artifact is a PROTECTED COMPOSITE —
 * base×(1−mask) + fill×mask — so every unmasked pixel survives BY
 * CONSTRUCTION; a pixel-diff assertion double-checks outside the mask
 * (tolerance only inside the feathered boundary band).
 *
 * Durable: same contract as the VTON adapters — request id persisted before
 * polling, restart resumes the same paid request, download failure retries
 * retrieval only.
 */
import {
  clearFalRequestState,
  extractFalImageUrl,
  runFalQueueJob,
  storagePathToBuffer,
} from '../client.mjs'
import { falInputFingerprint } from '../fingerprint.mjs'

export const FLUX_FILL_ENDPOINT = 'fal-ai/flux-pro/v1/fill'

/** Build the exact Fill payload (exported for contract tests). CS7 defaults:
 * enhance_prompt=false (no rewriting), 1 image, PNG, conservative safety. */
export function buildFluxFillInput({ imageDataUri, maskDataUri, prompt, seed }) {
  if (!prompt || !prompt.trim()) throw new Error('fill prompt required')
  return {
    image_url: imageDataUri,
    mask_url: maskDataUri,
    prompt: prompt.trim(),
    num_images: 1,
    output_format: 'png',
    enhance_prompt: false,
    safety_tolerance: '2',
    sync_mode: false,
    ...(Number.isFinite(seed) ? { seed } : {}),
  }
}

/**
 * Protected composite + pixel-diff assertion.
 * @returns {{ composited: Buffer, maxKeepDelta: number, keepChangedPct: number, width: number, height: number }}
 */
export async function protectedComposite({ baseBuf, maskBuf, fillBuf }) {
  const sharp = (await import('sharp')).default
  const base = sharp(baseBuf).rotate()
  const meta = await base.metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (!width || !height) throw new Error('base image unreadable')

  const baseRgb = await sharp(await base.png().toBuffer()).ensureAlpha().raw().toBuffer()
  const fillRgb = await sharp(fillBuf).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer()
  const maskGray = await sharp(maskBuf).resize(width, height, { fit: 'fill' }).grayscale().raw().toBuffer()

  // out = base×(1−m) + fill×m, per-pixel with the (possibly feathered) mask.
  const out = Buffer.alloc(baseRgb.length)
  for (let p = 0, g = 0; p < baseRgb.length; p += 4, g += 1) {
    const m = maskGray[g] / 255
    const inv = 1 - m
    out[p] = Math.round(baseRgb[p] * inv + fillRgb[p] * m)
    out[p + 1] = Math.round(baseRgb[p + 1] * inv + fillRgb[p + 1] * m)
    out[p + 2] = Math.round(baseRgb[p + 2] * inv + fillRgb[p + 2] * m)
    out[p + 3] = 255
  }

  // Assertion: fully-KEEP pixels (mask < 8 ≈ outside the feather band) must be
  // byte-identical to the base in the composited output.
  let maxKeepDelta = 0
  let changed = 0
  let keepCount = 0
  for (let p = 0, g = 0; p < baseRgb.length; p += 4, g += 1) {
    if (maskGray[g] < 8) {
      keepCount++
      const d = Math.max(
        Math.abs(out[p] - baseRgb[p]),
        Math.abs(out[p + 1] - baseRgb[p + 1]),
        Math.abs(out[p + 2] - baseRgb[p + 2]),
      )
      if (d > maxKeepDelta) maxKeepDelta = d
      if (d > 2) changed++
    }
  }
  const keepChangedPct = keepCount ? (changed / keepCount) * 100 : 0
  if (maxKeepDelta > 2) {
    // By construction this cannot happen (rounding is ≤1) — a violation means a
    // bug in the composite itself. Fail loudly rather than ship a lie.
    throw new Error(`protected pixels changed (maxDelta ${maxKeepDelta}) — composite bug`)
  }

  const composited = await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer()
  return { composited, maxKeepDelta, keepChangedPct, width, height }
}

function bufferToDataUri(buf, mime) {
  return `data:${mime};base64,${buf.toString('base64')}`
}

export async function processFluxFill({ supabase, pendingActionId, payload, logCost }) {
  const { baseImagePath, maskPath, fillPrompt } = payload
  if (!baseImagePath || !maskPath) throw new Error('flux-fill needs baseImagePath + maskPath')

  const [baseBuf, maskBuf] = await Promise.all([
    storagePathToBuffer(supabase, baseImagePath),
    storagePathToBuffer(supabase, maskPath),
  ])

  const sharp = (await import('sharp')).default
  // Send the base at its stored resolution (already ≤2048 from upload), PNG for
  // precision; the mask goes exactly as stored (dims validated at upload).
  const basePng = await sharp(baseBuf).rotate().png().toBuffer()
  const baseMeta = await sharp(basePng).metadata()
  const maskPng = await sharp(maskBuf).grayscale().png().toBuffer()

  const input = buildFluxFillInput({
    imageDataUri: bufferToDataUri(basePng, 'image/png'),
    maskDataUri: bufferToDataUri(maskPng, 'image/png'),
    prompt: fillPrompt,
    seed: payload.seed,
  })
  const fingerprint = falInputFingerprint(FLUX_FILL_ENDPOINT, {
    baseImagePath,
    maskPath,
    prompt: input.prompt,
    seed: input.seed ?? null,
  })

  const out = await runFalQueueJob({
    supabase,
    pendingActionId,
    endpointId: FLUX_FILL_ENDPOINT,
    input,
    inputFingerprint: fingerprint,
  })
  const url = extractFalImageUrl(out.payload)
  if (!url) throw new Error('flux-fill: no image in fal result')
  const fillRes = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!fillRes.ok) throw new Error(`fal output download HTTP ${fillRes.status}`)
  const fillBuf = Buffer.from(await fillRes.arrayBuffer())

  // Protected merge — unmasked pixels come from the ORIGINAL base, always.
  const { composited, maxKeepDelta, keepChangedPct, width, height } = await protectedComposite({
    baseBuf,
    maskBuf,
    fillBuf,
  })

  const storagePath = `generated/studio-${pendingActionId}.png`
  const { error: upErr } = await supabase.storage.from('agent-files').upload(storagePath, composited, {
    contentType: 'image/png',
    upsert: true,
  })
  if (upErr) throw new Error(`upload failed: ${upErr.message}`)
  await clearFalRequestState(supabase, pendingActionId)

  const { calcFluxFillCostUsd } = await import('../../cost-log.mjs')
  const costUsd = calcFluxFillCostUsd(baseMeta.width ?? width, baseMeta.height ?? height)
  void logCost({
    provider: 'fal',
    kind: 'image',
    units: {
      engine: 'fal_flux_fill',
      endpoint: FLUX_FILL_ENDPOINT,
      requestId: out.requestId,
      preset: payload.maskPreset ?? 'custom',
      megapixels: Math.ceil(((baseMeta.width ?? width) * (baseMeta.height ?? height)) / 1_000_000),
      seed: input.seed ?? null,
    },
    costUsd,
    jobId: pendingActionId,
    dedupKey: `fal:${pendingActionId}:1`,
  })

  return {
    storagePath,
    allPaths: [storagePath],
    provider: 'fal',
    falEngine: 'fal_flux_fill',
    falEndpointId: FLUX_FILL_ENDPOINT,
    requestId: out.requestId,
    seed: out.payload?.seed ?? payload.seed ?? null,
    latencyMs: out.latencyMs,
    costUsd,
    maskPath,
    baseImagePath,
    maskPreset: payload.maskPreset ?? 'custom',
    protectedDiff: { maxKeepDelta, keepChangedPct: Math.round(keepChangedPct * 100) / 100 },
    qc: null,
  }
}
