/**
 * Creative Studio post-processing: thumbnails + brand overlay.
 *
 * After an image is generated (Gemini OR FASHN) we:
 *   1. build a small webp thumbnail so the gallery grid loads fast (was loading
 *      multi-MB full-res PNGs as thumbs — owner complaint "gallery slow");
 *   2. optionally stamp the owner's brand logo + product code + a short hook onto
 *      a SEPARATE "branded" variant (the original stays untouched), driven by the
 *      `cs_branding` kv setting the owner manages from the Studio UI.
 *
 * Everything is best-effort: any failure returns what it has and never blocks the
 * job result — a missing thumbnail/branding must never lose the real image.
 */

const THUMB_WIDTH = 480

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

async function getSharp() {
  return (await import('sharp')).default
}

/** Read + parse the owner's branding config from agent_kv_settings. */
export async function fetchBrandingConfig(supabase) {
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', 'cs_branding')
      .maybeSingle()
    if (!data?.value) return null
    const cfg = JSON.parse(data.value)
    if (!cfg || cfg.enabled === false) return null
    return cfg
  } catch {
    return null
  }
}

async function downloadFromStorage(supabase, path) {
  const { data, error } = await supabase.storage.from('agent-files').download(path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

/** Build a compact webp thumbnail. Returns its storage path or null. */
export async function makeThumbnail(supabase, pendingActionId, sourceBuffer, suffix = '') {
  try {
    const sharp = await getSharp()
    const thumb = await sharp(sourceBuffer)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()
    const thumbPath = `generated/thumbs/${pendingActionId}${suffix ? `-${suffix}` : ''}.webp`
    const { error } = await supabase.storage
      .from('agent-files')
      .upload(thumbPath, thumb, { contentType: 'image/webp', upsert: true })
    if (error) return null
    return thumbPath
  } catch (err) {
    console.warn(`[branding] thumbnail failed for ${pendingActionId}:`, err.message)
    return null
  }
}

/**
 * Composite logo + code + hook onto the image. Returns branded storage path or
 * null (e.g. branding disabled / no logo configured).
 */
export async function makeBrandedVariant(supabase, pendingActionId, sourceBuffer, config, { productCode, hook } = {}) {
  if (!config) return null
  try {
    const sharp = await getSharp()
    const base = sharp(sourceBuffer)
    const meta = await base.metadata()
    const W = meta.width || 1080
    const H = meta.height || 1350

    const overlays = []

    // ── Logo ────────────────────────────────────────────────────────────────
    if (config.logoPath) {
      const logoBuf = await downloadFromStorage(supabase, config.logoPath)
      if (logoBuf) {
        const widthPct = clamp(Number(config.logoWidthPct) || 16, 5, 40)
        const logoW = Math.round((W * widthPct) / 100)
        const resizedLogo = await sharp(logoBuf)
          .resize({ width: logoW, withoutEnlargement: false })
          .png()
          .toBuffer()
        const lMeta = await sharp(resizedLogo).metadata()
        const logoH = lMeta.height || logoW
        const margin = Math.round((W * (clamp(Number(config.marginPct) || 4, 1, 15))) / 100)
        const placement = config.placement || 'bottom-right'
        const { left, top } = placeBox(placement, W, H, logoW, logoH, margin)
        overlays.push({ input: resizedLogo, left, top })
      }
    }

    // ── Text strip (hook + code) at the bottom ───────────────────────────────
    const effectiveHook = (hook && String(hook).trim()) || (config.defaultHook && String(config.defaultHook).trim()) || ''
    const showHook = config.showHook !== false && Boolean(effectiveHook)
    const showCode = config.showCode !== false && productCode
    if (showHook || showCode) {
      const textColor = sanitizeColor(config.textColor) || '#FFFFFF'
      const hookSize = Math.round(W * 0.045)
      const codeSize = Math.round(W * 0.028)
      const padX = Math.round(W * 0.04)
      const stripH = Math.round(H * (showHook && showCode ? 0.18 : 0.12))
      const baseY = H - Math.round(H * 0.05)
      const hookY = showCode ? baseY - codeSize - Math.round(H * 0.012) : baseY
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.62"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${H - stripH}" width="${W}" height="${stripH}" fill="url(#g)"/>
  ${showHook ? `<text x="${padX}" y="${hookY}" font-family="sans-serif" font-size="${hookSize}" font-weight="800" fill="${textColor}" stroke="#000000" stroke-width="${Math.max(1, Math.round(hookSize * 0.03))}" paint-order="stroke">${escapeXml(truncate(effectiveHook, 42))}</text>` : ''}
  ${showCode ? `<text x="${padX}" y="${baseY}" font-family="sans-serif" font-size="${codeSize}" font-weight="600" fill="${textColor}" opacity="0.92">${escapeXml(String(config.codePrefix ?? 'Code: '))}${escapeXml(truncate(productCode, 32))}</text>` : ''}
</svg>`
      overlays.push({ input: Buffer.from(svg), left: 0, top: 0 })
    }

    if (!overlays.length) return null

    const branded = await base.composite(overlays).png().toBuffer()
    const brandedPath = `generated/branded/${pendingActionId}.png`
    const { error } = await supabase.storage
      .from('agent-files')
      .upload(brandedPath, branded, { contentType: 'image/png', upsert: true })
    if (error) return null
    return brandedPath
  } catch (err) {
    console.warn(`[branding] branded variant failed for ${pendingActionId}:`, err.message)
    return null
  }
}

/**
 * One-shot post-process: download the final image once, produce a thumbnail and
 * (if configured) a branded variant. Best-effort — returns {} on any problem.
 */
export async function postProcessImage(supabase, pendingActionId, storagePath, { productCode, hook } = {}) {
  const out = {}
  const buf = await downloadFromStorage(supabase, storagePath)
  if (!buf) return out

  const config = await fetchBrandingConfig(supabase)
  const [thumbPath, brandedPath] = await Promise.all([
    makeThumbnail(supabase, pendingActionId, buf),
    makeBrandedVariant(supabase, pendingActionId, buf, config, { productCode, hook }),
  ])
  if (thumbPath) out.thumbPath = thumbPath
  if (brandedPath) {
    out.brandedPath = brandedPath
    // also a thumbnail of the branded version for the gallery tile
    const brandedBuf = await downloadFromStorage(supabase, brandedPath)
    if (brandedBuf) {
      const bThumb = await makeThumbnail(supabase, pendingActionId, brandedBuf, 'branded')
      if (bThumb) out.brandedThumbPath = bThumb
    }
  }
  return out
}

// ── helpers ──────────────────────────────────────────────────────────────────

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function truncate(s, max) {
  const str = String(s ?? '')
  return str.length > max ? `${str.slice(0, max - 1)}…` : str
}

function sanitizeColor(c) {
  if (typeof c !== 'string') return null
  return /^#[0-9a-fA-F]{3,8}$/.test(c.trim()) ? c.trim() : null
}

function placeBox(placement, W, H, w, h, margin) {
  switch (placement) {
    case 'top-left':
      return { left: margin, top: margin }
    case 'top-right':
      return { left: W - w - margin, top: margin }
    case 'bottom-left':
      return { left: margin, top: H - h - margin }
    case 'bottom-center':
      return { left: Math.round((W - w) / 2), top: H - h - margin }
    case 'bottom-right':
    default:
      return { left: W - w - margin, top: H - h - margin }
  }
}
