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

export type { BrandTheme }

const PRODUCT_CARD_SIZE = 1080
const MODEL_CANVAS = { width: 1080, height: 1350 } as const
const LIFESTYLE_SIZE = 1080
/** Default bottom-right call-to-action when the owner leaves the offer field blank. */
const DEFAULT_OFFER = 'অফার প্রাইস জানতে ইনবক্স করুন'

/**
 * Greedy word-wrap for SVG text (librsvg has no auto-wrap). Packs words up to
 * ~maxChars per line; once it reaches the final allowed line it keeps appending so
 * nothing is dropped. Bangla clusters are wide, so callers pass a small maxChars.
 */
function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const lines: string[] = []
  let cur = ''
  for (const wd of words) {
    const tentative = cur ? `${cur} ${wd}` : wd
    if (tentative.length > maxChars && cur && lines.length < maxLines - 1) {
      lines.push(cur)
      cur = wd
    } else {
      cur = tentative
    }
  }
  if (cur) lines.push(cur)
  return lines.slice(0, maxLines)
}

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
function buildLifestyleOverlaySvg(opts: {
  accent: string
  eyebrow: string
  headline: string
  offer: string
  code: string
}): Buffer {
  const S = LIFESTYLE_SIZE
  const fonts = buildBrandFontFaces()
  const accent = opts.accent
  const cream = BRAND.colors.cream
  const charcoal = BRAND.colors.charcoal
  const pad = 64

  const eyebrow = escapeXml(opts.eyebrow.slice(0, 32))
  const code = escapeXml(opts.code.slice(0, 16))
  const est = escapeXml(BRAND.est)
  const headlineLines = wrapText(opts.headline, 15, 2).map(escapeXml)
  const offerLines = wrapText(opts.offer, 18, 2).map(escapeXml)

  // top-right CODE ring
  const circleR = 46
  const circleCx = S - pad - circleR
  const circleCy = 124
  const codeSize = code.length > 7 ? 18 : 24

  // bottom-left block laid out bottom-up from the mustard rule
  const ruleY = 1018
  const hlSize = 54
  const hlLeading = 62
  const nHl = Math.max(1, headlineLines.length)
  const lastHlBaseline = ruleY - 16
  const firstHlBaseline = lastHlBaseline - (nHl - 1) * hlLeading
  const eyebrowBaseline = firstHlBaseline - 46
  const headlineSvg = headlineLines
    .map((ln, i) => `<text x="${pad}" y="${firstHlBaseline + i * hlLeading}" fill="${cream}" font-family="${BRAND_FONT.serif}" font-size="${hlSize}" font-weight="700">${ln}</text>`)
    .join('\n  ')

  // bottom-right offer block (right-aligned)
  const offerRight = S - pad
  const offerSize = 30
  const offerLeading = 40
  const nOf = Math.max(1, offerLines.length)
  const offerLastBaseline = 998
  const offerFirstBaseline = offerLastBaseline - (nOf - 1) * offerLeading
  const offerSvg = offerLines
    .map((ln, i) => `<text x="${offerRight}" y="${offerFirstBaseline + i * offerLeading}" fill="${cream}" font-family="${BRAND_FONT.serif}" font-size="${offerSize}" text-anchor="end">${ln}</text>`)
    .join('\n  ')

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

  <text x="${circleCx}" y="58" fill="${accent}" font-family="${BRAND_FONT.display}" font-size="17" letter-spacing="3" text-anchor="middle">CODE</text>
  <circle cx="${circleCx}" cy="${circleCy}" r="${circleR}" fill="none" stroke="${accent}" stroke-width="2.5"/>
  ${code ? `<text x="${circleCx}" y="${circleCy + Math.round(codeSize / 3)}" fill="${accent}" font-family="${BRAND_FONT.serif}" font-size="${codeSize}" font-weight="700" text-anchor="middle">${code}</text>` : ''}

  <text x="${pad}" y="${eyebrowBaseline}" fill="${accent}" font-family="${BRAND_FONT.serif}" font-size="27">${eyebrow}</text>
  ${headlineSvg}
  <rect x="${pad}" y="${ruleY}" width="74" height="3" fill="${accent}"/>

  ${offerSvg}

  <text x="${Math.round(S / 2)}" y="1048" fill="${accent}" font-family="${BRAND_FONT.display}" font-size="16" letter-spacing="2" text-anchor="middle">${est}</text>
  <circle cx="${S - pad + 4}" cy="1034" r="18" fill="none" stroke="${cream}" stroke-width="1.5" opacity="0.85"/>
  <text x="${S - pad + 4}" y="1041" fill="${cream}" font-family="${BRAND_FONT.display}" font-size="18" text-anchor="middle" opacity="0.9">A</text>
</svg>`)
}

async function renderLifestylePoster(imagePath: string, opts: {
  accent: string
  eyebrow: string
  headline: string
  offer: string
  code: string
}): Promise<Buffer> {
  const sharp = (await import('sharp')).default
  const photoBuf = await agentStorageDownload(imagePath)
  const S = LIFESTYLE_SIZE

  // Full-bleed square. `attention` keeps faces/garment in frame when the source
  // isn't square, instead of a blind centre crop.
  const base = await sharp(photoBuf)
    .resize(S, S, { fit: 'cover', position: 'attention' })
    .toBuffer()

  const overlay = buildLifestyleOverlaySvg(opts)
  const composites: Array<{ input: Buffer; top: number; left: number }> = [
    { input: overlay, top: 0, left: 0 },
  ]
  // Brand logo top-left, on top of the soft top scrim so it reads on busy photos.
  await compositeLogo(composites, true, 280, 54, 60)

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

  const outPath = `content/framed/${code}-${Date.now()}-${randomUUID().slice(0, 8)}.jpg`
  await agentStorageUpload(outPath, framed, 'image/jpeg')
  return outPath
}
