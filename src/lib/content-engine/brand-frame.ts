import { randomUUID } from 'crypto'
import { agentStorageDownload, agentStorageUpload } from '@/agent/lib/storage'
import {
  BRAND,
  BRAND_FONT,
  THEME_ACCENT,
  buildBrandFontFaces,
  getLogoPath,
  type BrandTheme,
} from '@/lib/content-engine/brand-identity'

export type { BrandTheme }

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

  const base = await sharp(photoBuf)
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .toBuffer()

  const { topBand, codeBadge, footerBand } = buildModelOverlaySvg(width, height, opts)
  const composites: Array<{ input: Buffer; top: number; left: number }> = [
    { input: topBand, top: 0, left: 0 },
    { input: codeBadge, top: height - 48 - (footerBand ? 56 : 0), left: 0 },
  ]
  if (footerBand) {
    composites.push({ input: footerBand, top: height - 56, left: 0 })
  }
  await compositeLogo(composites, true, 140, 20, 20)

  return sharp(base)
    .composite(composites)
    .jpeg({ quality: 92 })
    .toBuffer()
}

/**
 * Deterministic brand frame — logo, typography, hook via code (never AI-rendered text).
 */
export async function applyBrandFrame(
  imagePath: string,
  opts: {
    mode: 'product_card' | 'model_overlay'
    productName?: string
    productCode?: string
    price?: string
    hook: string
    theme?: BrandTheme
    footer?: boolean
  },
): Promise<string> {
  const accentRow = themeAccent(opts.theme)
  const accent = accentRow.accent
  const code = opts.productCode ?? 'ALMA'

  let framed: Buffer
  if (opts.mode === 'product_card') {
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
