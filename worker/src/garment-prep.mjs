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
const CACHE_PREFIX = 'garment_prep_v2:'
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
export async function prepSupplierPhoto({ supabase, imagePath }) {
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
  const scaleX = W / smallW
  const scaleY = H / smallH
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i]
    const mx = Math.round(c.width * scaleX * CROP_MARGIN)
    const my = Math.round(c.height * scaleY * CROP_MARGIN)
    const left = Math.max(0, Math.round(c.x * scaleX) - mx)
    const top = Math.max(0, Math.round(c.y * scaleY) - my)
    const cw = Math.min(W - left, Math.round(c.width * scaleX) + mx * 2)
    const ch = Math.min(H - top, Math.round(c.height * scaleY) + my * 2)
    // crop the CUTOUT (smooth alpha) and flatten onto white — background,
    // including any marketing text plate, can never reach the try-on engine
    const crop = await sharp(cutout)
      .extract({ left, top, width: cw, height: ch })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer()
    const path = `prepped/${imagePath.replace(/[^a-zA-Z0-9]/g, '_').slice(-60)}-v2p${i + 1}.png`
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
  }
  await writeCache(supabase, imagePath, result)
  console.log(`[garment-prep] ${imagePath} — ${persons.length} person(s) split`)
  return result
}
