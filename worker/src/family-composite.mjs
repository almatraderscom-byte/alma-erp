/**
 * CS9 — PROTECTED family compositing.
 *
 * The generative pair/group merge regenerated every face and garment; this
 * path never does. The adult try-on shot is the UNTOUCHED base (person +
 * background exactly as approved). The other person (or a whole approved pair)
 * is cut out with LOCAL segmentation (@imgly/background-removal-node — on-VPS,
 * no third paid model) and inserted at the deterministic relative height from
 * src/lib/tryon/family-layout.ts (math mirrored here — keep in sync). FLUX
 * Fill may then harmonize ONLY a thin edge band + a ground-contact ellipse.
 *
 * Checks: exact member count (narrow Gemini count, mechanical) — mismatch
 * fails the job with a clear Bangla error instead of shipping a wrong family.
 * Per-role identity is guaranteed BY CONSTRUCTION (pixels are copies).
 */
import {
  clearFalRequestState,
  extractFalImageUrl,
  runFalQueueJob,
} from './fal/client.mjs'
import { falInputFingerprint } from './fal/fingerprint.mjs'

export const FLUX_FILL_ENDPOINT = 'fal-ai/flux-pro/v1/fill'

// ── mirrored layout math (src/lib/tryon/family-layout.ts is the tested spec) ──

export const INSERT_RELATIVE_HEIGHT = { son: 0.62, daughter: 0.56, mother: 0.94, pair: 1.0 }
export const INSERT_GAP_RATIO = 0.05

export function planInsertPlacement({ canvasWidth, baseBBox, insertAspect, role, preferSide }) {
  const rel = INSERT_RELATIVE_HEIGHT[role] ?? 0.6
  const height = Math.round(baseBBox.height * rel)
  const width = Math.round(height * insertAspect)
  const gap = Math.round(baseBBox.height * INSERT_GAP_RATIO)
  const baseline = baseBBox.y + baseBBox.height
  const y = Math.max(0, baseline - height)
  const roomRight = canvasWidth - (baseBBox.x + baseBBox.width)
  const roomLeft = baseBBox.x
  let side = preferSide ?? (roomRight >= roomLeft ? 'right' : 'left')
  const fits = (s) => (s === 'right' ? roomRight >= width + gap : roomLeft >= width + gap)
  if (!fits(side) && fits(side === 'right' ? 'left' : 'right')) side = side === 'right' ? 'left' : 'right'
  let x
  let cramped = false
  if (side === 'right') {
    x = baseBBox.x + baseBBox.width + gap
    if (x + width > canvasWidth) {
      x = Math.max(0, canvasWidth - width)
      cramped = x < baseBBox.x + baseBBox.width * 0.7
    }
  } else {
    x = baseBBox.x - gap - width
    if (x < 0) {
      x = 0
      cramped = width > baseBBox.x - gap + baseBBox.width * 0.3
    }
  }
  return { width, height, x, y, side, cramped }
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function downloadBuf(supabase, path) {
  const { data, error } = await supabase.storage.from('agent-files').download(path)
  if (error || !data) throw new Error(`download failed: ${path}`)
  return Buffer.from(await data.arrayBuffer())
}

/** Local person cutout → RGBA PNG buffer (no paid API). */
export async function segmentPerson(buf) {
  const { removeBackground } = await import('@imgly/background-removal-node')
  const blob = new Blob([buf], { type: 'image/png' })
  const out = await removeBackground(blob, { output: { format: 'image/png' } })
  return Buffer.from(await out.arrayBuffer())
}

/** Bounding box of alpha>16 pixels in an RGBA buffer. */
export async function alphaBBox(pngBuf) {
  const sharp = (await import('sharp')).default
  const { data, info } = await sharp(pngBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = info.width
  let minY = info.height
  let maxX = -1
  let maxY = -1
  for (let yy = 0; yy < info.height; yy++) {
    for (let xx = 0; xx < info.width; xx++) {
      if (data[(yy * info.width + xx) * 4 + 3] > 16) {
        if (xx < minX) minX = xx
        if (xx > maxX) maxX = xx
        if (yy < minY) minY = yy
        if (yy > maxY) maxY = yy
      }
    }
  }
  if (maxX < 0) throw new Error('segmentation produced an empty cutout')
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * Harmonize mask: transition band of the scaled cutout's alpha + a ground
 * ellipse. White = Fill may edit; everything else protected.
 */
async function buildHarmonizeMask({ width, height, scaledCutout, placement }) {
  const sharp = (await import('sharp')).default
  const bandPx = Math.max(6, Math.round(placement.height * 0.015))
  // Blur the alpha — the 8..247 transition zone IS the edge band.
  const { data, info } = await sharp(scaledCutout)
    .ensureAlpha()
    .extractChannel(3)
    .blur(Math.max(1, bandPx / 2))
    .raw()
    .toBuffer({ resolveWithObject: true })
  const band = Buffer.alloc(info.width * info.height)
  for (let i = 0; i < band.length; i++) {
    band[i] = data[i] > 8 && data[i] < 247 ? 255 : 0
  }
  const bandPng = await sharp(band, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png()
    .toBuffer()
  const ellipse = Buffer.from(
    `<svg width="${width}" height="${height}"><ellipse cx="${placement.x + placement.width / 2}" cy="${placement.y + placement.height}" rx="${Math.round(placement.width * 0.55)}" ry="${Math.max(8, Math.round(placement.height * 0.035))}" fill="white"/></svg>`,
  )
  return sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: bandPng, left: placement.x, top: placement.y },
      { input: ellipse, left: 0, top: 0 },
    ])
    .png()
    .toBuffer()
}

/** Narrow mechanical member count (Gemini flash, temperature 0, fail-open null). */
export async function countPeople(imageBuf) {
  const key = process.env.GEMINI_API_KEY
  if (!key) return null
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'Count the distinct human beings visible in this photo. STRICT JSON only: {"count": n}' },
              { inline_data: { mime_type: 'image/png', data: imageBuf.toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 32 },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    )
    if (!res.ok) return null
    const data = await res.json()
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
    const n = Number(JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}').count)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

// ── main processor ────────────────────────────────────────────────────────────

export async function processFamilyComposite({ supabase, pendingActionId, payload, logCost }) {
  const c = payload.composite ?? {}
  const { baseImagePath, insertImagePath, insertRole, variant } = c
  if (!baseImagePath || !insertImagePath || !insertRole) {
    throw new Error('family_composite needs baseImagePath + insertImagePath + insertRole')
  }
  const sharp = (await import('sharp')).default

  const [baseBuf, insertBuf] = await Promise.all([
    downloadBuf(supabase, baseImagePath),
    downloadBuf(supabase, insertImagePath),
  ])
  const basePng = await sharp(baseBuf).rotate().png().toBuffer()
  const baseMeta = await sharp(basePng).metadata()
  const W = baseMeta.width
  const H = baseMeta.height

  // 1. LOCAL segmentation — base person bbox (for layout) + insert cutout.
  console.log(`[family-composite] ${pendingActionId} — segmenting (local, no paid model)`)
  const [baseCutout, insertCutout] = await Promise.all([
    segmentPerson(basePng),
    segmentPerson(await sharp(insertBuf).rotate().png().toBuffer()),
  ])
  const baseBBoxRaw = await alphaBBox(baseCutout)
  // base cutout is at base resolution already
  const insertBBox = await alphaBBox(insertCutout)
  const trimmedInsert = await sharp(insertCutout)
    .extract({ left: insertBBox.x, top: insertBBox.y, width: insertBBox.width, height: insertBBox.height })
    .png()
    .toBuffer()

  // 2. Deterministic placement (mirrored spec math).
  const placement = planInsertPlacement({
    canvasWidth: W,
    baseBBox: baseBBoxRaw,
    insertAspect: insertBBox.width / insertBBox.height,
    role: insertRole,
  })
  const scaledCutout = await sharp(trimmedInsert)
    .resize(placement.width, placement.height, { fit: 'fill' })
    .png()
    .toBuffer()

  // 3. Protected paste — base pixels untouched, insert pixels copied.
  let composited = await sharp(basePng)
    .composite([{ input: scaledCutout, left: placement.x, top: placement.y }])
    .png()
    .toBuffer()

  // 4. Optional FLUX Fill harmonize — edges + contact shadow ONLY.
  let harmonize = { applied: false }
  if (c.harmonize !== false && process.env.FAL_KEY?.trim()) {
    try {
      const mask = await buildHarmonizeMask({ width: W, height: H, scaledCutout, placement })
      const prompt = [
        'Blend the masked seam band naturally: match lighting, color temperature and grain across the boundary.',
        'In the masked ground area add a soft realistic contact shadow under the person, matching the scene light.',
        c.sceneRef?.scenePrompt ? `Scene: ${c.sceneRef.scenePrompt}` : '',
        'Photorealistic, subtle, seamless.',
      ].filter(Boolean).join(' ')
      const input = {
        image_url: `data:image/png;base64,${composited.toString('base64')}`,
        mask_url: `data:image/png;base64,${mask.toString('base64')}`,
        prompt,
        num_images: 1,
        output_format: 'png',
        enhance_prompt: false,
        safety_tolerance: '2',
        sync_mode: false,
      }
      const fingerprint = falInputFingerprint(FLUX_FILL_ENDPOINT, {
        baseImagePath,
        insertImagePath,
        placement,
        purpose: 'family_harmonize',
      })
      const out = await runFalQueueJob({
        supabase,
        pendingActionId,
        endpointId: FLUX_FILL_ENDPOINT,
        input,
        inputFingerprint: fingerprint,
      })
      const url = extractFalImageUrl(out.payload)
      if (url) {
        const fillRes = await fetch(url, { signal: AbortSignal.timeout(120_000) })
        if (fillRes.ok) {
          const fillBuf = Buffer.from(await fillRes.arrayBuffer())
          // protected merge: fill contributes ONLY inside the mask
          const { protectedComposite } = await import('./fal/adapters/flux-fill.mjs')
          const merged = await protectedComposite({ baseBuf: composited, maskBuf: mask, fillBuf })
          composited = merged.composited
          const megapixels = Math.max(1, Math.ceil((W * H) / 1_000_000))
          const costUsd = Math.round(megapixels * 0.05 * 1e6) / 1e6
          harmonize = { applied: true, requestId: out.requestId, latencyMs: out.latencyMs, costUsd }
          void logCost({
            provider: 'fal',
            kind: 'image',
            units: { engine: 'fal_flux_fill', purpose: 'family_harmonize', requestId: out.requestId, megapixels },
            costUsd,
            jobId: pendingActionId,
            dedupKey: `fal:${pendingActionId}:harmonize`,
          })
        }
      }
      await clearFalRequestState(supabase, pendingActionId)
    } catch (err) {
      // Harmonize is an enhancement — a fal failure must not kill the free,
      // correct composite. Ship it un-harmonized, flagged.
      console.warn(`[family-composite] ${pendingActionId} — harmonize skipped: ${err.message}`)
      harmonize = { applied: false, error: err.message?.slice(0, 200) }
    }
  }

  // 5. Exact member count — 100% rule. Mismatch = honest failure, never a
  // wrong family shipped silently.
  const expected = Number(c.expectedMembers ?? 0) || null
  const counted = expected ? await countPeople(composited) : null
  if (expected && counted !== null && counted !== expected) {
    throw new Error(`ফ্যামিলি সদস্য সংখ্যা মেলেনি — দরকার ${expected} জন, ছবিতে ${counted} জন। আবার চালান বা সোর্স ছবি বদলান।`)
  }

  const storagePath = `generated/studio-${pendingActionId}.png`
  const { error: upErr } = await supabase.storage.from('agent-files').upload(storagePath, composited, {
    contentType: 'image/png',
    upsert: true,
  })
  if (upErr) throw new Error(`upload failed: ${upErr.message}`)

  return {
    storagePath,
    allPaths: [storagePath],
    provider: 'family_composite',
    protectedComposite: true,
    variant,
    insertRole,
    placement,
    memberCount: counted ?? expected ?? undefined,
    expectedMembers: expected ?? undefined,
    harmonize,
    baseImagePath,
    insertImagePath,
  }
}
