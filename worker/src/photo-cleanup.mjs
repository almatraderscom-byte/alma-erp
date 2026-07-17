/**
 * Model-photo marketing-plate cleanup (owner reality 2026-07-17: saved model
 * photos are often reseller shots carrying a dark "CODE-xxx PRICE-xxxTK"
 * plate — FASHN keeps the model image's background, so the plate rides into
 * EVERY paid output).
 *
 * Deterministic and FREE (no LLM, no paid API):
 *  1. downscale + threshold: find DARK near-uniform rectangles (the plate);
 *  2. person mask = LARGEST alpha component only — the segmenter often keeps
 *     overlaid text/plates as "foreground", but they are disconnected from
 *     the person, so component-splitting excludes them (live-proven on the
 *     olive supplier photo where the v2 garment crop retained overlay text);
 *  3. smear-fill each plate row-wise from its flanking pixels + blur — reads
 *     as bokeh on typical outdoor shots; person pixels stay pixel-identical.
 *
 * Results are cached per image path (kv model_clean:<path>); photos with no
 * detected plate return the ORIGINAL path and cache that verdict.
 *
 * Known limits (deliberate): only dark plates are detected — bright/white
 * plates risk false positives (lamps, sky); boxless stroked text is untouched.
 */
import { segmentPerson } from './family-composite.mjs'
import { connectedComponents } from './garment-prep.mjs'

const CACHE_PREFIX = 'model_clean:'
const SCALE_W = 256
const DARK_MAX = 90 // r,g,b all below → "plate-dark"
const MIN_AREA_FRAC = 0.005
const MAX_AREA_FRAC = 0.2
const MIN_FILL_RATIO = 0.65 // component area / bbox area — rectangles, not blobs
const MIN_OUTSIDE_PERSON = 0.6

/**
 * Pure detector (exported for tests). rgb = interleaved RGB, personMask =
 * 0/1 Uint8Array at the same scale (largest-component only) or null.
 * @returns {{boxes: Array<{x:number,y:number,width:number,height:number}>, fillMask: Uint8Array}}
 *   fillMask marks EXACTLY the accepted components' dark pixels — filling only
 *   those preserves background objects (lamps, grass) sharing the bbox.
 */
export function detectDarkPlates(rgb, width, height, personMask) {
  const dark = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = rgb[i * 3]
    const g = rgb[i * 3 + 1]
    const b = rgb[i * 3 + 2]
    dark[i] = r < DARK_MAX && g < DARK_MAX && b < DARK_MAX ? 1 : 0
  }
  const comps = connectedComponents(dark, width, height)
  const total = width * height
  const boxes = []
  const fillMask = new Uint8Array(width * height)
  for (const c of comps) {
    const bboxArea = c.width * c.height
    if (bboxArea < MIN_AREA_FRAC * total || bboxArea > MAX_AREA_FRAC * total) continue
    if (c.area / bboxArea < MIN_FILL_RATIO) continue
    if (personMask) {
      let onPerson = 0
      let darkCount = 0
      for (let yy = c.y; yy < c.y + c.height; yy++) {
        for (let xx = c.x; xx < c.x + c.width; xx++) {
          const idx = yy * width + xx
          if (!dark[idx]) continue
          darkCount++
          if (personMask[idx]) onPerson++
        }
      }
      if (darkCount === 0 || 1 - onPerson / darkCount < MIN_OUTSIDE_PERSON) continue
    }
    boxes.push({ x: c.x, y: c.y, width: c.width, height: c.height })
    // mark this component's own pixels: re-flood from a seed inside its bbox
    floodInto(fillMask, dark, width, height, c)
  }
  return { boxes, fillMask }
}

/**
 * Fill interior holes of a 0/1 mask (pure, exported for tests): pixels not
 * reachable from the image border through zero-pixels become 1. This captures
 * the WHITE text glyphs enclosed by a dark plate — they are not dark
 * themselves, but they are holes inside the dark component.
 */
export function fillMaskHoles(mask, width, height) {
  const reach = new Uint8Array(width * height)
  const stack = []
  const push = (idx) => { if (!mask[idx] && !reach[idx]) { reach[idx] = 1; stack.push(idx) } }
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x) }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1) }
  while (stack.length) {
    const idx = stack.pop()
    const x = idx % width
    const y = (idx / width) | 0
    if (x > 0) push(idx - 1)
    if (x < width - 1) push(idx + 1)
    if (y > 0) push(idx - width)
    if (y < height - 1) push(idx + width)
  }
  const out = new Uint8Array(mask)
  for (let i = 0; i < out.length; i++) if (!out[i] && !reach[i]) out[i] = 1
  return out
}

/** Flood-fill component c's pixels of `mask` into `out` (4-connectivity). */
function floodInto(out, mask, width, height, c) {
  let seed = -1
  for (let y = c.y; y < c.y + c.height && seed < 0; y++) {
    for (let x = c.x; x < c.x + c.width; x++) {
      if (mask[y * width + x] && !out[y * width + x]) { seed = y * width + x; break }
    }
  }
  if (seed < 0) return
  const stack = [seed]
  out[seed] = 1
  while (stack.length) {
    const idx = stack.pop()
    const x = idx % width
    const y = (idx / width) | 0
    if (x > 0 && mask[idx - 1] && !out[idx - 1]) { out[idx - 1] = 1; stack.push(idx - 1) }
    if (x < width - 1 && mask[idx + 1] && !out[idx + 1]) { out[idx + 1] = 1; stack.push(idx + 1) }
    if (y > 0 && mask[idx - width] && !out[idx - width]) { out[idx - width] = 1; stack.push(idx - width) }
    if (y < height - 1 && mask[idx + width] && !out[idx + width]) { out[idx + width] = 1; stack.push(idx + width) }
  }
}

/**
 * Pure per-row segment fill (exported for tests). Mutates rgb in place.
 * For each horizontal run of fillMask pixels (skipping person pixels), lerps
 * between the nearest non-fill non-person pixel on each side — background
 * objects inside the bbox but outside the mask are untouched.
 */
export function smearFillMask(rgb, width, height, fillMask, personMask) {
  const skip = (idx) => fillMask[idx] || (personMask && personMask[idx])
  for (let y = 0; y < height; y++) {
    let x = 0
    while (x < width) {
      const idx = y * width + x
      if (!fillMask[idx] || (personMask && personMask[idx])) { x++; continue }
      let xe = x
      while (xe + 1 < width && fillMask[y * width + xe + 1] && !(personMask && personMask[y * width + xe + 1])) xe++
      // nearest clean flank pixels
      let lx = x - 1
      while (lx >= 0 && skip(y * width + lx)) lx--
      let rx = xe + 1
      while (rx < width && skip(y * width + rx)) rx++
      const li = lx >= 0 ? (y * width + lx) * 3 : rx < width ? (y * width + rx) * 3 : -1
      const ri = rx < width ? (y * width + rx) * 3 : li
      if (li < 0) { x = xe + 1; continue } // whole row masked — leave as-is
      for (let xx = x; xx <= xe; xx++) {
        const t = (xx - x + 1) / (xe - x + 2)
        const o = (y * width + xx) * 3
        for (let ch = 0; ch < 3; ch++) {
          rgb[o + ch] = Math.round(rgb[li + ch] * (1 - t) + rgb[ri + ch] * t)
        }
      }
      x = xe + 1
    }
  }
}

/** 0/1 mask of the LARGEST component of a 0/1 mask (pure, exported for tests). */
export function largestComponentMask(mask, width, height) {
  const comps = connectedComponents(mask, width, height)
  if (!comps.length) return new Uint8Array(width * height)
  const best = comps.reduce((a, b) => (b.area > a.area ? b : a))
  // re-flood from inside the winning bbox to rebuild just that component
  const out = new Uint8Array(width * height)
  const stack = []
  let seed = -1
  for (let y = best.y; y < best.y + best.height && seed < 0; y++) {
    for (let x = best.x; x < best.x + best.width; x++) {
      if (mask[y * width + x]) { seed = y * width + x; break }
    }
  }
  if (seed < 0) return out
  stack.push(seed)
  out[seed] = 1
  while (stack.length) {
    const idx = stack.pop()
    const x = idx % width
    const y = (idx / width) | 0
    if (x > 0 && mask[idx - 1] && !out[idx - 1]) { out[idx - 1] = 1; stack.push(idx - 1) }
    if (x < width - 1 && mask[idx + 1] && !out[idx + 1]) { out[idx + 1] = 1; stack.push(idx + 1) }
    if (y > 0 && mask[idx - width] && !out[idx - width]) { out[idx - width] = 1; stack.push(idx - width) }
    if (y < height - 1 && mask[idx + width] && !out[idx + width]) { out[idx + width] = 1; stack.push(idx + width) }
  }
  return out
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
 * Returns a storage path safe to hand to a try-on engine as the MODEL image:
 * the original path when clean, or a `cleaned/…` copy with plates filled.
 * Fail-open: any error returns the original path.
 */
export async function cleanModelPhoto({ supabase, imagePath }) {
  try {
    const cached = await readCache(supabase, imagePath)
    if (cached?.path) return cached.path

    const sharp = (await import('sharp')).default
    const { data: file, error } = await supabase.storage.from('agent-files').download(imagePath)
    if (error || !file) throw new Error(`download failed: ${imagePath}`)
    const original = Buffer.from(await file.arrayBuffer())
    const basePng = await sharp(original).rotate().png().toBuffer()
    const meta = await sharp(basePng).metadata()
    const W = meta.width
    const H = meta.height
    const smallW = SCALE_W
    const smallH = Math.max(8, Math.round((H / W) * smallW))

    const smallRgb = await sharp(basePng).resize(smallW, smallH, { fit: 'fill' }).removeAlpha().raw().toBuffer()

    // quick pre-pass without the (slow) segmenter: any plate-shaped darkness?
    if (!detectDarkPlates(smallRgb, smallW, smallH, null).boxes.length) {
      await writeCache(supabase, imagePath, { path: imagePath, plates: 0 })
      return imagePath
    }

    console.log(`[photo-cleanup] ${imagePath} — plate candidate(s) found, segmenting`)
    const cutout = await segmentPerson(basePng)
    const alphaSmall = await sharp(cutout).ensureAlpha().extractChannel(3).resize(smallW, smallH, { fit: 'fill' }).raw().toBuffer()
    const alphaBin = new Uint8Array(alphaSmall.length)
    for (let i = 0; i < alphaSmall.length; i++) alphaBin[i] = alphaSmall[i] > 32 ? 1 : 0
    // largest component only — overlay text/plates the segmenter kept are
    // disconnected from the person and must NOT count as person
    const personSmall = largestComponentMask(alphaBin, smallW, smallH)

    const { boxes, fillMask: rawFillMask } = detectDarkPlates(smallRgb, smallW, smallH, personSmall)
    if (!boxes.length) {
      await writeCache(supabase, imagePath, { path: imagePath, plates: 0 })
      return imagePath
    }
    // white text glyphs are holes inside the dark plate — fill them too
    const fillMask = fillMaskHoles(rawFillMask, smallW, smallH)

    // full-res person + fill masks from the small-scale masks (fill mask gets
    // a slight dilation from the smooth resize threshold)
    const upscaleMask = async (small, threshold) => {
      // NB: resolveWithObject — sharp may widen a 1-channel raw to 3 on resize
      const { data: raw, info } = await sharp(Buffer.from(small.map((v) => v * 255)), {
        raw: { width: smallW, height: smallH, channels: 1 },
      }).resize(W, H, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
      const stride = info.channels
      const out = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) out[i] = raw[i * stride] > threshold ? 1 : 0
      return out
    }
    const personFull = await upscaleMask(personSmall, 64)
    const fillFull = await upscaleMask(fillMask, 24) // low threshold ≈ dilate

    // smear-fill ONLY the plate component pixels (person + background objects
    // like lamps stay untouched)
    const fullRgb = await sharp(basePng).removeAlpha().raw().toBuffer()
    smearFillMask(fullRgb, W, H, fillFull, personFull)

    // blur the filled frame once, then paste back ONLY the filled pixels
    const blurred = await sharp(Buffer.from(fullRgb), { raw: { width: W, height: H, channels: 3 } })
      .blur(8)
      .raw()
      .toBuffer()
    const rgba = Buffer.alloc(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = blurred[i * 3]
      rgba[i * 4 + 1] = blurred[i * 3 + 1]
      rgba[i * 4 + 2] = blurred[i * 3 + 2]
      rgba[i * 4 + 3] = fillFull[i] && !personFull[i] ? 255 : 0
    }
    const overlay = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
    const outBuf = await sharp(basePng).composite([{ input: overlay, left: 0, top: 0 }]).png().toBuffer()

    const path = `cleaned/${imagePath.replace(/[^a-zA-Z0-9]/g, '_').slice(-60)}.png`
    const { error: upErr } = await supabase.storage.from('agent-files').upload(path, outBuf, {
      contentType: 'image/png',
      upsert: true,
    })
    if (upErr) throw new Error(`cleanup upload failed: ${upErr.message}`)
    await writeCache(supabase, imagePath, { path, plates: boxes.length })
    console.log(`[photo-cleanup] ${imagePath} — ${boxes.length} plate(s) filled → ${path}`)
    return path
  } catch (err) {
    console.warn(`[photo-cleanup] ${imagePath} — skipped (${err.message})`)
    return imagePath
  }
}
