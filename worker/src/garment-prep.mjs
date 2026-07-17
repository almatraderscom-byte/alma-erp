/**
 * Supplier-photo garment prep (owner reality 2026-07-17: resellers never send
 * garment-only photos — always on-model or on-mannequin, often multi-person
 * with marketing text).
 *
 * Deterministic, FREE (local segmentation, no paid model):
 *  1. segment the supplier photo (reuses the CS9 local segmenter);
 *  2. split the alpha into connected components = individual people/mannequins;
 *  3. crop the segmented CUTOUT around each person (small margin) and flatten
 *     onto white — marketing text/price plates in the background are removed
 *     BY CONSTRUCTION (live 2026-07-17: cropping the original kept a
 *     "CODE-133 PRICE-1450TK" plate inside the person bbox and FASHN baked it
 *     into the paid output — background pixels must never reach the engine);
 *  4. tallest crop = adult piece, shortest = child piece (real child garment —
 *     no more AI-imagined child version when the supplier photo includes it).
 *
 * Results are cached per image path (kv garment_prep:<path>) so repeat runs
 * cost nothing.
 */
import { segmentPerson } from './family-composite.mjs'

// v2: crops switched from original-photo to white-flattened cutout (text-plate fix)
// v3: bright overlay text INSIDE the person alpha scrubbed from each crop
//     (live 2026-07-17: Bangla hem lettering survived v2 and FASHN copied it
//     onto the child's panjabi)
const CACHE_PREFIX = 'garment_prep_v3:'
const LABEL_SCALE_W = 256 // label components on a small mask — fast + robust
const MIN_COMPONENT_AREA = 0.04 // ≥4% of pixels to count as a person
const CROP_MARGIN = 0.06

/**
 * Two-pass-ish connected component labeling on a binary mask (pure, exported
 * for tests). 4-connectivity, iterative stack flood fill.
 * @param {Uint8Array} mask 0/1 values
 * @returns {Array<{x:number,y:number,width:number,height:number,area:number}>}
 */
export function connectedComponents(mask, width, height) {
  const labels = new Int32Array(width * height)
  const boxes = []
  let next = 0
  const stack = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    next++
    let minX = width; let maxX = -1; let minY = height; let maxY = -1; let area = 0
    stack.length = 0
    stack.push(start)
    labels[start] = next
    while (stack.length) {
      const idx = stack.pop()
      const x = idx % width
      const y = (idx / width) | 0
      area++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      // 4-neighbours
      if (x > 0 && mask[idx - 1] && !labels[idx - 1]) { labels[idx - 1] = next; stack.push(idx - 1) }
      if (x < width - 1 && mask[idx + 1] && !labels[idx + 1]) { labels[idx + 1] = next; stack.push(idx + 1) }
      if (y > 0 && mask[idx - width] && !labels[idx - width]) { labels[idx - width] = next; stack.push(idx - width) }
      if (y < height - 1 && mask[idx + width] && !labels[idx + width]) { labels[idx + width] = next; stack.push(idx + width) }
    }
    boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area })
  }
  return boxes
}

/**
 * Remove bright overlay lettering inside the person alpha from a flattened
 * crop. `cutRaw` = the crop's raw RGBA buffer (alpha already limited to the
 * person component). Fail-open: returns the crop unchanged on any error.
 */
async function scrubOverlayText(sharp, flatCrop, cutRaw, dims) {
  try {
    const { detectBrightTextInAlpha, smearFillMask } = await import('./photo-cleanup.mjs')
    const { data: rgbRaw, info } = await sharp(flatCrop).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const W = info.width
    const H = info.height
    const alpha = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) alpha[i] = cutRaw[i * dims.channels + 3] > 32 ? 1 : 0
    const rgb = new Uint8Array(rgbRaw)
    const textMask = detectBrightTextInAlpha(rgb, W, H, alpha)
    let n = 0
    for (let i = 0; i < textMask.length; i++) n += textMask[i]
    if (!n) return flatCrop
    // flanks must be garment pixels, not the white background — treat
    // outside-alpha as untouchable AND unusable for sampling
    const notAlpha = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) notAlpha[i] = alpha[i] ? 0 : 1
    smearFillMask(rgb, W, H, textMask, notAlpha)
    console.log(`[garment-prep] overlay text scrub: ${n}px filled`)
    return await sharp(Buffer.from(rgb), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()
  } catch (err) {
    console.warn(`[garment-prep] text scrub skipped (${err.message})`)
    return flatCrop
  }
}

/**
 * Narrow MECHANICAL text-box detection (Gemini flash, temperature 0) — the
 * owner's no-LLM-creative-judgment rule allows mechanical sub-tasks; this
 * returns bounding boxes only, it decides nothing creative. Fail-open [].
 * @returns {Promise<Array<{x0:number,y0:number,x1:number,y1:number}>>} 0-1 normalized
 */
export async function detectOverlayTextBoxes(imageBuf, onDebug) {
  const key = process.env.GEMINI_API_KEY
  if (!key) { onDebug?.({ reason: 'no_key' }); return [] }
  // 2.5-flash boxes markedly better; 2.0-flash is the fallback
  for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                // canonical Gemini detection format — the model is trained on
                // "box_2d" [ymin,xmin,ymax,xmax] 0-1000; custom shapes often
                // come back empty (live 2026-07-17: boxes:0 on obvious text)
                { text: 'Detect every region of overlaid graphic text, watermark or logo in this product photo (any language, any colour), including decorative Bangla lettering. Exclude fabric embroidery patterns, buttons and natural objects. Output ONLY a JSON list where each entry has the 2D bounding box in "box_2d" ([ymin, xmin, ymax, xmax], normalized 0-1000) and a short "label". Output [] if there is none.' },
                { inline_data: { mime_type: 'image/png', data: imageBuf.toString('base64') } },
              ],
            }],
            // 2.5-flash burns "thinking" tokens against maxOutputTokens — live
            // 2026-07-17 it emitted valid box_2d JSON and hit MAX_TOKENS at
            // 1024 mid-array. Budget up + thinking off.
            generationConfig: { temperature: 0, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
          }),
          signal: AbortSignal.timeout(30_000),
        },
      )
      if (!res.ok) { onDebug?.({ model, http: res.status }); continue }
      const data = await res.json()
      const raw = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')
      onDebug?.({ model, raw: raw.slice(0, 220), finish: data.candidates?.[0]?.finishReason })
      // canonical: [{"box_2d":[ymin,xmin,ymax,xmax],"label":...}]; also accept
      // the legacy {"boxes":[[...]]} shape
      const arrMatch = raw.match(/\[[\s\S]*\]/)
      let rawBoxes = []
      if (arrMatch) {
        try {
          const list = JSON.parse(arrMatch[0])
          if (Array.isArray(list)) {
            rawBoxes = list.map((e) => (Array.isArray(e) ? e : e?.box_2d)).filter(Boolean)
          }
        } catch { /* fall through */ }
      }
      if (!rawBoxes.length) {
        try {
          const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
          if (Array.isArray(obj.boxes)) rawBoxes = obj.boxes
        } catch { /* fall through */ }
      }
      if (!rawBoxes.length) {
        // truncation-tolerant salvage: every complete "box_2d": [a,b,c,d]
        // survives even when MAX_TOKENS cuts the array mid-stream
        for (const m of raw.matchAll(/"box_2d"\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g)) {
          rawBoxes.push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
        }
      }
      const boxes = rawBoxes
        .filter((b) => Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(v)))
        .map(([ymin, xmin, ymax, xmax]) => ({ x0: xmin / 1000, y0: ymin / 1000, x1: xmax / 1000, y1: ymax / 1000 }))
        .filter((b) => b.x1 > b.x0 && b.y1 > b.y0)
      if (boxes.length) return boxes
      // empty from this model — let the fallback model try
    } catch (err) {
      onDebug?.({ model, error: String(err?.message ?? err).slice(0, 120) })
      // try the next model
    }
  }
  return []
}

/**
 * One-time paid cleanup of remaining overlay text on a prep crop: FLUX Fill
 * repaints ONLY the text boxes (protected composite guarantees every other
 * pixel is byte-identical). Fail-open: returns the crop unchanged.
 */
async function inpaintTextBoxes({ supabase, pendingActionId, cropPng, boxes, imagePath, cropIndex, logCost, onSkip }) {
  if (!pendingActionId) { onSkip?.('no_action_id'); return cropPng } // durable Fal state needs an action id
  try {
    // owner kill switch for Fill — skip silently when explicitly off
    const { data: flag } = await supabase
      .from('agent_kv_settings').select('value').eq('key', 'cs_flux_fill_enabled').maybeSingle()
    if (flag && ['false', '0', 'off'].includes(String(flag.value).trim().toLowerCase())) { onSkip?.('fill_flag_off'); return cropPng }

    const sharp = (await import('sharp')).default
    const meta = await sharp(cropPng).metadata()
    const W = meta.width
    const H = meta.height
    const pad = 0.015
    const rects = boxes.map((b) => {
      const left = Math.max(0, Math.round((b.x0 - pad) * W))
      const top = Math.max(0, Math.round((b.y0 - pad) * H))
      return {
        left,
        top,
        width: Math.min(W - left, Math.round((b.x1 - b.x0 + pad * 2) * W)),
        height: Math.min(H - top, Math.round((b.y1 - b.y0 + pad * 2) * H)),
      }
    }).filter((r) => r.width > 2 && r.height > 2)
    if (!rects.length) { onSkip?.('rects_empty'); return cropPng }

    const maskBuf = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).composite(rects.map((r) => ({
      input: { create: { width: r.width, height: r.height, channels: 3, background: { r: 255, g: 255, b: 255 } } },
      left: r.left,
      top: r.top,
    }))).blur(2).png().toBuffer()

    const { buildFluxFillInput, protectedComposite, FLUX_FILL_ENDPOINT } = await import('./fal/adapters/flux-fill.mjs')
    const { runFalQueueJob, clearFalRequestState, isEngineKilled, extractFalImageUrl } = await import('./fal/client.mjs')
    const { falInputFingerprint } = await import('./fal/fingerprint.mjs')
    if (await isEngineKilled(supabase, 'fal_flux_fill')) { onSkip?.('engine_killed'); return cropPng }

    const toUri = (buf) => `data:image/png;base64,${buf.toString('base64')}`
    const input = buildFluxFillInput({
      imageDataUri: toUri(cropPng),
      maskDataUri: toUri(maskBuf),
      prompt: 'Remove the overlaid marketing text completely. Reconstruct the clean fabric texture and plain background exactly as they would look without the text. No new objects, no text, no logos.',
    })
    const fingerprint = falInputFingerprint(FLUX_FILL_ENDPOINT, {
      purpose: 'garment-prep-text-inpaint',
      imagePath,
      cropIndex,
      boxes: rects,
    })
    const out = await runFalQueueJob({
      supabase,
      pendingActionId,
      endpointId: FLUX_FILL_ENDPOINT,
      input,
      inputFingerprint: fingerprint,
    })
    await clearFalRequestState(supabase, pendingActionId)
    const url = extractFalImageUrl(out.payload)
    if (!url) { onSkip?.('no_fill_image_url'); return cropPng }
    const fillRes = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!fillRes.ok) { onSkip?.('fill_download_http_' + fillRes.status); return cropPng }
    const fillBuf = Buffer.from(await fillRes.arrayBuffer())
    const { composited } = await protectedComposite({ baseBuf: cropPng, maskBuf, fillBuf })
    void logCost?.({
      provider: 'fal',
      kind: 'image',
      units: { engine: 'fal_flux_fill', endpoint: FLUX_FILL_ENDPOINT, purpose: 'garment_prep_text_inpaint', requestId: out.requestId, cropIndex },
      costUsd: 0.1,
      jobId: pendingActionId,
      dedupKey: `fal:${pendingActionId}:prep-fill-${cropIndex}`,
    })
    console.log(`[garment-prep] FLUX Fill removed ${rects.length} text box(es) on crop ${cropIndex}`)
    return composited
  } catch (err) {
    onSkip?.('error: ' + err.message)
    console.warn(`[garment-prep] text inpaint skipped (${err.message})`)
    return cropPng
  }
}

async function readCache(supabase, imagePath) {
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', `${CACHE_PREFIX}${imagePath}`)
      .maybeSingle()
    return data?.value ? JSON.parse(data.value) : null
  } catch {
    return null
  }
}

async function writeCache(supabase, imagePath, result) {
  try {
    await supabase.from('agent_kv_settings').upsert(
      { key: `${CACHE_PREFIX}${imagePath}`, value: JSON.stringify(result) },
      { onConflict: 'key' },
    )
  } catch { /* best-effort */ }
}

/**
 * @returns {Promise<{multiPerson:boolean, persons:Array<{path:string,heightPx:number}>,
 *   adultGarmentPath:string|null, childGarmentPath:string|null}>}
 */
export async function prepSupplierPhoto({ supabase, imagePath, pendingActionId, logCost }) {
  const cached = await readCache(supabase, imagePath)
  if (cached?.persons) return cached

  const sharp = (await import('sharp')).default
  const { data: file, error } = await supabase.storage.from('agent-files').download(imagePath)
  if (error || !file) throw new Error(`download failed: ${imagePath}`)
  const original = Buffer.from(await file.arrayBuffer())
  const basePng = await sharp(original).rotate().png().toBuffer()
  const meta = await sharp(basePng).metadata()
  const W = meta.width
  const H = meta.height

  console.log(`[garment-prep] ${imagePath} — segmenting (local, free)`)
  const cutout = await segmentPerson(basePng)

  // downscale the alpha for labeling
  const smallW = LABEL_SCALE_W
  const smallH = Math.max(8, Math.round((H / W) * smallW))
  const alpha = await sharp(cutout)
    .ensureAlpha()
    .extractChannel(3)
    .resize(smallW, smallH, { fit: 'fill' })
    .raw()
    .toBuffer()
  const mask = new Uint8Array(alpha.length)
  for (let i = 0; i < alpha.length; i++) mask[i] = alpha[i] > 32 ? 1 : 0

  const comps = connectedComponents(mask, smallW, smallH)
    .filter((c) => c.area >= MIN_COMPONENT_AREA * smallW * smallH)
    .sort((a, b) => b.height - a.height)
    .slice(0, 4)

  const persons = []
  const textScrubDebug = []
  const scaleX = W / smallW
  const scaleY = H / smallH
  const { floodInto } = await import('./photo-cleanup.mjs')
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i]
    const mx = Math.round(c.width * scaleX * CROP_MARGIN)
    const my = Math.round(c.height * scaleY * CROP_MARGIN)
    const left = Math.max(0, Math.round(c.x * scaleX) - mx)
    const top = Math.max(0, Math.round(c.y * scaleY) - my)
    const cw = Math.min(W - left, Math.round(c.width * scaleX) + mx * 2)
    const ch = Math.min(H - top, Math.round(c.height * scaleY) + my * 2)
    // v3: limit the crop's alpha to THIS person component only — the
    // segmenter keeps disconnected overlay text/graphics as foreground, and
    // component-masking removes them regardless of colour
    const compSmall = new Uint8Array(smallW * smallH)
    floodInto(compSmall, mask, smallW, smallH, c)
    const { data: compRaw, info: compInfo } = await sharp(Buffer.from(compSmall.map((v) => v * 255)), {
      raw: { width: smallW, height: smallH, channels: 1 },
    }).resize(W, H, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
    const { data: cut, info: cutInfo } = await sharp(cutout)
      .extract({ left, top, width: cw, height: ch })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const full = ((top + y) * W + (left + x)) * compInfo.channels
        if (compRaw[full] <= 24) cut[(y * cw + x) * cutInfo.channels + 3] = 0
      }
    }
    // flatten onto white — background and any marketing plate can never
    // reach the try-on engine
    const flat = await sharp(Buffer.from(cut), { raw: { width: cw, height: ch, channels: cutInfo.channels } })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer()
    // v3a (free): scrub bright low-saturation glyph clusters inside the alpha
    let crop = await scrubOverlayText(sharp, flat, Buffer.from(cut), { width: cw, height: ch, channels: cutInfo.channels })
    // v3b (paid, one-time per photo, kv-cached): whatever text survives the
    // pixel heuristics (coloured/decorated lettering, smoke-connected blobs)
    // is boxed by a narrow mechanical Gemini call and repainted by FLUX Fill
    // under a protected composite
    const debug = { crop: i + 1, boxes: 0, inpainted: false, reason: null, det: [] }
    const boxes = await detectOverlayTextBoxes(crop, (d) => debug.det.push(d))
    debug.boxes = boxes.length
    if (boxes.length) {
      const before = crop
      crop = await inpaintTextBoxes({
        supabase, pendingActionId, cropPng: crop, boxes, imagePath, cropIndex: i + 1, logCost,
        onSkip: (reason) => { debug.reason = reason },
      })
      debug.inpainted = crop !== before
    } else {
      debug.reason = 'no_boxes_detected'
    }
    textScrubDebug.push(debug)
    console.log(`[garment-prep] crop ${i + 1} text-scrub debug: ${JSON.stringify(debug)}`)
    const path = `prepped/${imagePath.replace(/[^a-zA-Z0-9]/g, '_').slice(-60)}-v3p${i + 1}.png`
    const { error: upErr } = await supabase.storage.from('agent-files').upload(path, crop, {
      contentType: 'image/png',
      upsert: true,
    })
    if (upErr) throw new Error(`prep upload failed: ${upErr.message}`)
    persons.push({ path, heightPx: ch })
  }

  const result = {
    multiPerson: persons.length > 1,
    persons,
    // tallest = adult piece; shortest = child piece (real supplier child garment)
    adultGarmentPath: persons[0]?.path ?? null,
    childGarmentPath: persons.length > 1 ? persons[persons.length - 1].path : null,
    textScrub: textScrubDebug,
  }
  await writeCache(supabase, imagePath, result)
  console.log(`[garment-prep] ${imagePath} — ${persons.length} person(s) split`)
  return result
}
