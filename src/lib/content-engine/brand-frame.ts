import { randomUUID } from 'crypto'
import { agentStorageDownload, agentStorageUpload } from '@/agent/lib/storage'
import {
  BRAND,
  BRAND_FONT,
  THEME_ACCENT,
  buildBrandFontFaces,
  ensureBrandFonts,
  getLogoPath,
  type BrandTheme,
} from '@/lib/content-engine/brand-identity'
import {
  LIFESTYLE_SIZE,
  LIFESTYLE_COLORS,
  DEFAULT_OFFER,
  computeAutoLayout,
  applyLayoutOverrides,
  type LifestyleLayout,
  type LifestyleLayoutOverrides,
  type TextEl,
} from '@/lib/content-engine/lifestyle-layout'

export type { BrandTheme }
export type { LifestyleLayoutOverrides }

const PRODUCT_CARD_SIZE = 1080
const MODEL_CANVAS = { width: 1080, height: 1350 } as const

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function themeAccent(theme?: BrandTheme) {
  return THEME_ACCENT[theme ?? 'default'] ?? THEME_ACCENT.default
}

async function loadLogoBuffer(transparent: boolean): Promise<Buffer | null> {
  try {
    const path = await getLogoPath(transparent)
    return await agentStorageDownload(path)
  } catch (err) {
    console.warn('[brand-frame] logo download failed:', err instanceof Error ? err.message : err)
    return null
  }
}

function buildProductCardSvg(opts: {
  hook: string
  eyebrow: string
  accent: string
  productName: string
  price: string
}): string {
  const w = PRODUCT_CARD_SIZE
  const h = PRODUCT_CARD_SIZE
  const fonts = buildBrandFontFaces()
  const eyebrowText = escapeXml(opts.hook || opts.eyebrow)
  const name = escapeXml(opts.productName.slice(0, 48))
  const price = escapeXml(opts.price)
  const est = escapeXml(BRAND.est)
  const leftCx = 300
  const eyebrowY = Math.round(h * 0.4)
  const headingY = eyebrowY + 40
  const sepY = headingY + 56
  const priceY = sepY + 32

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  ${fonts}
  <rect width="100%" height="100%" fill="${BRAND.colors.cream}"/>
  <text x="${leftCx}" y="${eyebrowY}" fill="${opts.accent}" font-family="${BRAND_FONT.serif}" font-size="22" letter-spacing="4" text-anchor="middle">${eyebrowText}</text>
  <text x="${leftCx}" y="${headingY}" fill="${BRAND.colors.charcoal}" font-family="${BRAND_FONT.serif}" font-size="56" font-weight="700" text-anchor="middle">${name}</text>
  <rect x="${leftCx - 50}" y="${sepY}" width="100" height="2" fill="${opts.accent}"/>
  <text x="${leftCx}" y="${priceY}" fill="${BRAND.colors.charcoal}" font-family="${BRAND_FONT.serif}" font-size="36" text-anchor="middle">${price}</text>
  <text x="60" y="${h - 36}" fill="${BRAND.colors.charcoal}" font-family="${BRAND_FONT.display}" font-size="14">${est}</text>
</svg>`
}

function buildModelOverlaySvg(width: number, height: number, opts: {
  hook: string
  accent: string
  productCode: string
  footer?: boolean
}): { topBand: Buffer; codeBadge: Buffer; footerBand?: Buffer } {
  const fonts = buildBrandFontFaces()
  const hook = escapeXml(opts.hook.slice(0, 64))
  const code = escapeXml((opts.productCode ?? '').slice(0, 24))
  const est = escapeXml(BRAND.est)
  const page = escapeXml(BRAND.footer.page)
  const bandH = 72

  const topBand = Buffer.from(`<svg width="${width}" height="${bandH}" xmlns="http://www.w3.org/2000/svg">
  ${fonts}
  <rect width="100%" height="100%" fill="rgba(42,38,34,0.78)"/>
  <rect x="0" y="0" width="5" height="100%" fill="${opts.accent}"/>
  <text x="24" y="46" fill="${opts.accent}" font-family="${BRAND_FONT.serif}" font-size="20" font-weight="700" letter-spacing="2">${hook}</text>
</svg>`)

  const codeBadge = Buffer.from(`<svg width="${width}" height="48" xmlns="http://www.w3.org/2000/svg">
  ${fonts}
  <text x="${width - 20}" y="32" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.body}" font-size="14" text-anchor="end" opacity="0.92">${code}</text>
</svg>`)

  let footerBand: Buffer | undefined
  if (opts.footer) {
    const footerH = 56
    const contact = BRAND.footer.contact ? ` · ${escapeXml(BRAND.footer.contact)}` : ''
    footerBand = Buffer.from(`<svg width="${width}" height="${footerH}" xmlns="http://www.w3.org/2000/svg">
  ${fonts}
  <rect width="100%" height="100%" fill="rgba(245,235,221,0.94)"/>
  <text x="24" y="22" fill="${BRAND.colors.charcoal}" font-family="${BRAND_FONT.display}" font-size="12">${est}</text>
  <text x="24" y="42" fill="${BRAND.colors.charcoal}" font-family="${BRAND_FONT.body}" font-size="13">${page}${contact} · অর্ডার ইনবক্সে মেসেজ করুন</text>
</svg>`)
  }

  return { topBand, codeBadge, footerBand }
}

export async function compositeLogo(
  composites: Array<{ input: Buffer; top: number; left: number }>,
  transparent: boolean,
  widthPx: number,
  top: number,
  left: number,
): Promise<void> {
  const logoBuf = await loadLogoBuffer(transparent)
  if (!logoBuf) return
  const sharp = (await import('sharp')).default
  const resized = await sharp(logoBuf)
    .resize({ width: widthPx })
    .png()
    .toBuffer()
  composites.push({ input: resized, top, left })
}

async function renderProductCard(imagePath: string, opts: {
  hook: string
  accent: string
  eyebrow: string
  productName: string
  price: string
}): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const photoBuf = await agentStorageDownload(imagePath)
  const w = PRODUCT_CARD_SIZE
  const h = PRODUCT_CARD_SIZE
  const frameW = 400
  const frameH = 600
  const frameLeft = w - 80 - frameW
  const frameTop = Math.round((h - frameH) / 2)

  const productInFrame = await sharp(photoBuf)
    .resize(frameW, frameH, { fit: 'cover', position: 'centre' })
    .toBuffer()

  const textLayer = Buffer.from(buildProductCardSvg({
    hook: opts.hook,
    eyebrow: opts.eyebrow,
    accent: opts.accent,
    productName: opts.productName,
    price: opts.price,
  }))

  const composites: Array<{ input: Buffer; top: number; left: number }> = [
    { input: productInFrame, top: frameTop, left: frameLeft },
    { input: textLayer, top: 0, left: 0 },
  ]
  await compositeLogo(composites, false, 150, 60, 60)

  return sharp({
    create: { width: w, height: h, channels: 3, background: BRAND.colors.cream },
  })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toBuffer()
}

async function renderModelOverlay(imagePath: string, opts: {
  hook: string
  accent: string
  productCode: string
  footer?: boolean
}): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const photoBuf = await agentStorageDownload(imagePath)
  const { width, height } = MODEL_CANVAS

  // Preserve aspect ratio — NEVER crop the product. `fit: 'cover'` was cutting heads/
  // feet off portrait shots and zooming in (perceived "quality drop"). Instead fit the
  // whole image inside the canvas and letterbox the remainder with brand cream so the
  // full garment is always visible.
  const fitted = await sharp(photoBuf)
    .resize(width, height, { fit: 'inside', withoutEnlargement: false })
    .toBuffer()
  const fittedMeta = await sharp(fitted).metadata()
  const fittedW = fittedMeta.width ?? width
  const fittedH = fittedMeta.height ?? height
  const photoLeft = Math.round((width - fittedW) / 2)
  const photoTop = Math.round((height - fittedH) / 2)

  const { topBand, codeBadge, footerBand } = buildModelOverlaySvg(width, height, opts)
  const composites: Array<{ input: Buffer; top: number; left: number }> = [
    { input: fitted, top: photoTop, left: photoLeft },
    { input: topBand, top: 0, left: 0 },
    { input: codeBadge, top: height - 48 - (footerBand ? 56 : 0), left: 0 },
  ]
  if (footerBand) {
    composites.push({ input: footerBand, top: height - 56, left: 0 })
  }
  await compositeLogo(composites, true, 140, 20, 20)

  return sharp({
    create: { width, height, channels: 3, background: BRAND.colors.cream },
  })
    .composite(composites)
    .jpeg({ quality: 95 })
    .toBuffer()
}

/**
 * Full-bleed "lifestyle poster" overlay — the layout the owner finalised with the
 * reference card: the photo fills the whole 1080² square, a dark bottom gradient
 * lifts the copy, and brand text/graphics sit on top. ALL visible text is passed
 * in (editable per image), never AI-rendered, so Bangla stays crisp and correct.
 *
 *   top-left      → brand logo (composited separately)
 *   top-right     → "CODE" label + mustard ring with the product code
 *   bottom-left   → eyebrow, headline (1–2 lines), thin mustard rule
 *   bottom-right  → offer / call-to-action (1–2 lines, right-aligned)
 *   bottom-centre → EST. 2019 · DHAKA + small circled-A monogram
 */
/** Render one positioned text block (1–N lines, anchored per `justify`). */
function svgTextEl(el: TextEl, accent: string): string {
  if (!el.lines.length) return ''
  const fill = el.color === 'accent' ? accent : LIFESTYLE_COLORS.cream
  const fam = el.font === 'display' ? BRAND_FONT.display : BRAND_FONT.serif
  const wt = el.weight === 700 ? ' font-weight="700"' : ''
  const ls = el.letterSpacing ? ` letter-spacing="${el.letterSpacing}"` : ''
  return el.lines
    .map((ln, i) =>
      `<text x="${el.x}" y="${el.y + i * el.leading}" fill="${fill}" font-family="${fam}" font-size="${el.size}" text-anchor="${el.justify}"${wt}${ls}>${escapeXml(ln)}</text>`,
    )
    .join('\n  ')
}

/**
 * Full-bleed "lifestyle poster" overlay built from a {@link LifestyleLayout}.
 * Auto-finish and the drag/resize editor both produce that layout, so this is the
 * one renderer for both paths. ALL visible text is passed in (never AI-rendered)
 * so Bangla stays crisp and correct.
 *
 *   top-left      → brand logo (composited separately)
 *   top-right     → "CODE" label + mustard ring with the product code
 *   bottom-left   → eyebrow, headline (1–2 lines), thin mustard rule
 *   bottom-right  → offer / call-to-action (1–2 lines, right-aligned)
 *   bottom-centre → EST. 2019 · DHAKA + small circled-A monogram
 */
function buildLifestyleOverlaySvg(layout: LifestyleLayout, accent: string): Buffer {
  const S = LIFESTYLE_SIZE
  const fonts = buildBrandFontFaces()
  const cream = LIFESTYLE_COLORS.cream
  const charcoal = LIFESTYLE_COLORS.charcoal

  const { codeBadge: b, rule, monogram: m, logo: _logo } = layout
  void _logo // logo is composited as a raster, not drawn in SVG
  const code = escapeXml(b.code.slice(0, 16))
  const codeText = code
    ? `<text x="${b.cx}" y="${b.cy + Math.round(b.size / 3)}" fill="${cream}" font-family="${BRAND_FONT.serif}" font-size="${b.size}" font-weight="700" text-anchor="middle">${code}</text>`
    : ''

  return Buffer.from(`<svg width="${S}" height="${S}" xmlns="http://www.w3.org/2000/svg">
  ${fonts}
  <defs>
    <linearGradient id="bottomFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${charcoal}" stop-opacity="0"/>
      <stop offset="52%" stop-color="${charcoal}" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="${charcoal}" stop-opacity="0.9"/>
    </linearGradient>
    <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${charcoal}" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="${charcoal}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${S}" height="240" fill="url(#topFade)"/>
  <rect x="0" y="560" width="${S}" height="520" fill="url(#bottomFade)"/>

  <circle cx="${b.cx}" cy="${b.cy}" r="${b.r}" fill="${charcoal}" fill-opacity="0.26"/>
  <text x="${b.cx}" y="${b.cy + b.labelDy}" fill="${cream}" font-family="${BRAND_FONT.display}" font-size="${b.labelSize}" letter-spacing="3" text-anchor="middle" opacity="0.72">${escapeXml(b.label)}</text>
  <circle cx="${b.cx}" cy="${b.cy}" r="${b.r}" fill="none" stroke="${cream}" stroke-width="1.5" opacity="0.8"/>
  ${codeText}

  ${svgTextEl(layout.eyebrow, accent)}
  ${svgTextEl(layout.headline, accent)}
  <rect x="${rule.x}" y="${rule.y}" width="${rule.w}" height="${rule.h}" fill="${accent}"/>

  ${svgTextEl(layout.offer, accent)}

  ${svgTextEl(layout.est, accent)}
  <circle cx="${m.cx}" cy="${m.cy}" r="${m.r}" fill="none" stroke="${cream}" stroke-width="1.5" opacity="0.85"/>
  <text x="${m.cx}" y="${m.cy + Math.round(m.size * 0.39)}" fill="${cream}" font-family="${BRAND_FONT.display}" font-size="${m.size}" text-anchor="middle" opacity="0.9">${escapeXml(m.letter)}</text>
</svg>`)
}

async function renderLifestylePoster(imagePath: string, opts: {
  accent: string
  eyebrow: string
  headline: string
  offer: string
  code: string
  /** geometry overrides from the drag/resize editor (absent → pure auto-finish) */
  layout?: LifestyleLayoutOverrides | null
  /** 'cover' (default) crops to a square; 'contain' keeps the whole photo (no crop) */
  fit?: 'cover' | 'contain'
}): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const photoBuf = await agentStorageDownload(imagePath)
  const S = LIFESTYLE_SIZE

  // Build the layout: auto positions seeded from the text, then any editor tweaks.
  const layout = applyLayoutOverrides(
    computeAutoLayout({
      eyebrow: opts.eyebrow.slice(0, 32),
      headline: opts.headline,
      offer: opts.offer,
      code: opts.code,
      est: BRAND.est,
    }),
    opts.layout,
  )

  // The poster canvas is always a 1080² square so the overlay geometry lines up.
  //  • 'cover'   → fill the square, cropping overflow. `attention` keeps the
  //               face/garment in frame instead of a blind centre crop.
  //  • 'contain' → keep the WHOLE photo (nothing cropped): the full image is fit
  //               inside the square over a blurred, dimmed copy of itself so the
  //               letterbox bars look intentional rather than empty.
  let base: Buffer
  if (opts.fit === 'contain') {
    const bg = await sharp(photoBuf)
      .resize(S, S, { fit: 'cover', position: 'attention' })
      .blur(30)
      .modulate({ brightness: 0.62 })
      .toBuffer()
    const fg = await sharp(photoBuf).resize(S, S, { fit: 'inside' }).toBuffer()
    base = await sharp(bg).composite([{ input: fg, gravity: 'center' }]).toBuffer()
  } else {
    base = await sharp(photoBuf)
      .resize(S, S, { fit: 'cover', position: 'attention' })
      .toBuffer()
  }

  const overlay = buildLifestyleOverlaySvg(layout, opts.accent)
  const composites: Array<{ input: Buffer; top: number; left: number }> = [
    { input: overlay, top: 0, left: 0 },
  ]
  // Brand logo (raster) at the layout's logo box, on top of the soft top scrim.
  // sharp rejects negative composite offsets, so clamp the logo box on-canvas.
  await compositeLogo(
    composites,
    true,
    Math.round(layout.logo.w),
    Math.max(0, Math.round(layout.logo.y)),
    Math.max(0, Math.round(layout.logo.x)),
  )

  return sharp(base)
    .composite(composites)
    .jpeg({ quality: 94 })
    .toBuffer()
}

/**
 * Deterministic brand frame — logo, typography, hook via code (never AI-rendered text).
 */
export async function applyBrandFrame(
  imagePath: string,
  opts: {
    mode: 'product_card' | 'model_overlay' | 'lifestyle'
    productName?: string
    productCode?: string
    price?: string
    hook: string
    eyebrow?: string
    offer?: string
    theme?: BrandTheme
    footer?: boolean
    /** lifestyle only: geometry tweaks from the drag/resize editor */
    layout?: LifestyleLayoutOverrides | null
    /** lifestyle only: 'contain' keeps the whole photo (no crop); default 'cover' */
    fit?: 'cover' | 'contain'
  },
): Promise<string> {
  // Register bundled fonts with fontconfig BEFORE any librsvg text render — without
  // this, text is blank on Vercel/Lambda (no system fonts) and tofu on bare Linux.
  ensureBrandFonts()

  const accentRow = themeAccent(opts.theme)
  const accent = accentRow.accent
  const code = opts.productCode ?? 'ALMA'

  let framed: Buffer
  if (opts.mode === 'lifestyle') {
    framed = await renderLifestylePoster(imagePath, {
      accent,
      // hook carries the main headline; eyebrow + offer fall back to brand defaults.
      headline: opts.hook,
      eyebrow: (opts.eyebrow ?? '').trim() || accentRow.eyebrow,
      offer: (opts.offer ?? '').trim() || DEFAULT_OFFER,
      code: opts.productCode ?? '',
      layout: opts.layout ?? null,
      fit: opts.fit ?? 'cover',
    })
  } else if (opts.mode === 'product_card') {
    framed = await renderProductCard(imagePath, {
      hook: opts.hook,
      eyebrow: accentRow.eyebrow,
      accent,
      productName: opts.productName ?? code,
      price: opts.price ?? 'মাত্র ৳ —',
    })
  } else {
    framed = await renderModelOverlay(imagePath, {
      hook: opts.hook,
      accent,
      productCode: code,
      footer: opts.footer ?? false,
    })
  }

  // Supabase storage keys must be ASCII — a Bangla product code (e.g. "কোড-৩৫৪")
  // makes the key invalid (400 InvalidKey). Slug the code to safe chars; fall back
  // to the brand name when nothing ASCII survives.
  const safeCode = code.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'alma'
  const outPath = `content/framed/${safeCode}-${Date.now()}-${randomUUID().slice(0, 8)}.jpg`
  await agentStorageUpload(outPath, framed, 'image/jpeg')
  return outPath
}
