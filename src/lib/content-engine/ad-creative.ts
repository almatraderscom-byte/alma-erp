import { randomUUID } from 'crypto'
import { agentStorageDownload, agentStorageUpload } from '@/agent/lib/storage'
import {
  BRAND,
  BRAND_FONT,
  THEME_ACCENT,
  buildBrandFontFaces,
  ensureBrandFonts,
  type BrandTheme,
} from '@/lib/content-engine/brand-identity'
import { escapeXml, compositeLogo } from '@/lib/content-engine/brand-frame'

export type AdTemplate =
  | 'offer_band'
  | 'price_drop'
  | 'festival_hero'
  | 'new_arrival'
  | 'free_delivery'

export type AdAspect = '1:1' | '4:5' | '9:16'

export interface AdCreativeSpec {
  template: AdTemplate
  theme: BrandTheme
  headlineBn: string
  subBn?: string
  priceText?: string
  strikePriceText?: string
  discountText?: string
  ctaBn?: string
  urgencyBn?: string
  aspect: AdAspect
}

export function aspectDimensions(aspect: AdAspect): { w: number; h: number } {
  const w = 1080
  if (aspect === '1:1') return { w, h: 1080 }
  if (aspect === '4:5') return { w, h: 1350 }
  return { w, h: 1920 }
}

function themeRow(theme: BrandTheme) {
  return THEME_ACCENT[theme] ?? THEME_ACCENT.default
}

function bottomBandSvg(
  w: number,
  h: number,
  accent: string,
  lines: Array<{ text: string; size: number; weight?: number; fill?: string; yOffset: number }>,
): string {
  const bandH = Math.round(h * 0.34)
  const bandY = h - bandH
  const fonts = buildBrandFontFaces()
  const textEls = lines.map((line) => {
    const y = bandY + line.yOffset
    const weight = line.weight ? ` font-weight="${line.weight}"` : ''
    const fill = line.fill ?? BRAND.colors.cream
    return `<text x="${w / 2}" y="${y}" fill="${fill}" font-family="${BRAND_FONT.serif}" font-size="${line.size}"${weight} text-anchor="middle">${escapeXml(line.text)}</text>`
  }).join('\n')

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  ${fonts}
  <defs>
    <linearGradient id="bandGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(42,38,34,0)"/>
      <stop offset="35%" stop-color="rgba(42,38,34,0.82)"/>
      <stop offset="100%" stop-color="rgba(42,38,34,0.94)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${bandY}" width="${w}" height="${bandH}" fill="url(#bandGrad)"/>
  <rect x="0" y="${bandY}" width="6" height="${bandH}" fill="${accent}"/>
  ${textEls}
</svg>`
}

export function buildAdOverlaySvg(spec: AdCreativeSpec, w: number, h: number): string {
  const accent = themeRow(spec.theme).accent
  const eyebrow = themeRow(spec.theme).eyebrow
  const headline = spec.headlineBn.trim()
  const sub = spec.subBn?.trim() ?? ''
  const price = spec.priceText?.trim() ?? ''
  const strike = spec.strikePriceText?.trim() ?? ''
  const discount = spec.discountText?.trim() ?? ''
  const cta = spec.ctaBn?.trim() ?? 'অর্ডার করতে ইনবক্সে মেসেজ করুন'
  const urgency = spec.urgencyBn?.trim() ?? ''

  if (spec.template === 'price_drop') {
    const fonts = buildBrandFontFaces()
    const priceY = Math.round(h * 0.62)
    const strikeY = priceY - 44
    const discountY = priceY + 52
    return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  ${fonts}
  <rect x="0" y="${Math.round(h * 0.48)}" width="${w}" height="${Math.round(h * 0.52)}" fill="rgba(42,38,34,0.78)"/>
  <rect x="0" y="${Math.round(h * 0.48)}" width="6" height="${Math.round(h * 0.52)}" fill="${accent}"/>
  <text x="48" y="${Math.round(h * 0.54)}" fill="${accent}" font-family="${BRAND_FONT.serif}" font-size="24" letter-spacing="3">${escapeXml(eyebrow)}</text>
  <text x="48" y="${Math.round(h * 0.58)}" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.serif}" font-size="40" font-weight="700">${escapeXml(headline)}</text>
  ${strike ? `<text x="48" y="${strikeY}" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.body}" font-size="28" opacity="0.65"><tspan text-decoration="line-through">${escapeXml(strike)}</tspan></text>` : ''}
  ${price ? `<text x="48" y="${priceY}" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.serif}" font-size="64" font-weight="700">${escapeXml(price)}</text>` : ''}
  ${discount ? `<text x="48" y="${discountY}" fill="${accent}" font-family="${BRAND_FONT.serif}" font-size="32" font-weight="700">${escapeXml(discount)}</text>` : ''}
  ${urgency ? `<text x="48" y="${h - 48}" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.body}" font-size="20">${escapeXml(urgency)}</text>` : ''}
  <text x="48" y="${h - 20}" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.body}" font-size="18" opacity="0.9">${escapeXml(cta)}</text>
</svg>`
  }

  if (spec.template === 'festival_hero') {
    const fonts = buildBrandFontFaces()
    const topH = 88
    const bandY = h - Math.round(h * 0.34)
    const lines: string[] = []
    let yOff = bandY + 56
    if (sub) {
      lines.push(`<text x="${w / 2}" y="${yOff}" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.serif}" font-size="26" text-anchor="middle">${escapeXml(sub)}</text>`)
      yOff += 52
    }
    if (price) {
      lines.push(`<text x="${w / 2}" y="${yOff}" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.serif}" font-size="48" font-weight="700" text-anchor="middle">${escapeXml(price)}</text>`)
      yOff += 48
    }
    if (discount) {
      lines.push(`<text x="${w / 2}" y="${yOff}" fill="${accent}" font-family="${BRAND_FONT.serif}" font-size="30" font-weight="700" text-anchor="middle">${escapeXml(discount)}</text>`)
      yOff += 40
    }
    if (urgency) {
      lines.push(`<text x="${w / 2}" y="${h - 52}" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.body}" font-size="20" text-anchor="middle">${escapeXml(urgency)}</text>`)
    }
    lines.push(`<text x="${w / 2}" y="${h - 24}" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.body}" font-size="18" text-anchor="middle">${escapeXml(cta)}</text>`)

    return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  ${fonts}
  <rect width="100%" height="${topH}" fill="rgba(42,38,34,0.85)"/>
  <rect x="0" y="0" width="100%" height="5" fill="${accent}"/>
  <text x="${w / 2}" y="36" fill="${accent}" font-family="${BRAND_FONT.serif}" font-size="22" letter-spacing="4" text-anchor="middle">${escapeXml(eyebrow)}</text>
  <text x="${w / 2}" y="68" fill="${BRAND.colors.cream}" font-family="${BRAND_FONT.serif}" font-size="34" font-weight="700" text-anchor="middle">${escapeXml(headline)}</text>
  <rect x="0" y="${bandY}" width="${w}" height="${h - bandY}" fill="rgba(42,38,34,0.88)"/>
  <rect x="0" y="${bandY}" width="6" height="${h - bandY}" fill="${accent}"/>
  ${lines.join('\n')}
</svg>`
  }

  if (spec.template === 'new_arrival') {
    return bottomBandSvg(w, h, accent, [
      { text: eyebrow, size: 22, fill: accent, yOffset: 48 },
      { text: headline, size: 42, weight: 700, yOffset: 92 },
      ...(sub ? [{ text: sub, size: 24, yOffset: 132 }] : []),
      ...(price ? [{ text: price, size: 36, weight: 700, yOffset: sub ? 178 : 148 }] : []),
      { text: cta, size: 18, yOffset: h - bandOffset(h) - 12 },
    ])
  }

  if (spec.template === 'free_delivery') {
    return bottomBandSvg(w, h, accent, [
      { text: headline || 'ফ্রি ডেলিভারি', size: 40, weight: 700, yOffset: 64 },
      ...(sub ? [{ text: sub, size: 24, yOffset: 108 }] : []),
      ...(price ? [{ text: price, size: 32, weight: 700, yOffset: sub ? 152 : 116 }] : []),
      { text: cta, size: 22, weight: 700, fill: accent, yOffset: h - bandOffset(h) - 28 },
      { text: 'সীমিত সময়ের অফার', size: 18, yOffset: h - bandOffset(h) - 4 },
    ])
  }

  // offer_band (default)
  return bottomBandSvg(w, h, accent, [
    { text: headline, size: 40, weight: 700, yOffset: 52 },
    ...(sub ? [{ text: sub, size: 24, yOffset: 94 }] : []),
    ...(price ? [{ text: price, size: 44, weight: 700, yOffset: sub ? 142 : 108 }] : []),
    ...(strike ? [{ text: strike, size: 24, yOffset: sub ? 178 : 144 }] : []),
    ...(discount ? [{ text: discount, size: 30, weight: 700, fill: accent, yOffset: sub ? 218 : 184 }] : []),
    ...(urgency ? [{ text: urgency, size: 20, yOffset: h - bandOffset(h) - 36 }] : []),
    { text: cta, size: 18, yOffset: h - bandOffset(h) - 8 },
  ])
}

function bandOffset(h: number): number {
  return Math.round(h * 0.34)
}

export async function renderAdCreative(baseImagePath: string, spec: AdCreativeSpec): Promise<Buffer> {
  // Register bundled fonts with fontconfig BEFORE any librsvg text render — without
  // this, Bangla ad text is blank on Vercel/Lambda (no system fonts) and tofu on bare
  // Linux. Also prevents fontconfig from initialising without our font dirs in a warm
  // Lambda (which would then break the finish route's text too).
  ensureBrandFonts()
  const sharp = (await import('sharp')).default
  const { w, h } = aspectDimensions(spec.aspect)
  const photoBuf = await agentStorageDownload(baseImagePath)
  const base = await sharp(photoBuf)
    .resize(w, h, { fit: 'cover', position: 'centre' })
    .toBuffer()

  const overlay = Buffer.from(buildAdOverlaySvg(spec, w, h))
  const composites: Array<{ input: Buffer; top: number; left: number }> = [
    { input: overlay, top: 0, left: 0 },
  ]
  await compositeLogo(composites, true, Math.round(w * 0.13), 20, 20)

  return sharp(base)
    .composite(composites)
    .jpeg({ quality: 92 })
    .toBuffer()
}

export async function renderAndStoreAdCreative(
  baseImagePath: string,
  spec: AdCreativeSpec,
  key?: string,
): Promise<string> {
  const framed = await renderAdCreative(baseImagePath, spec)
  const outPath = `content/ad-creatives/${key ?? `${Date.now()}-${randomUUID().slice(0, 8)}`}.jpg`
  await agentStorageUpload(outPath, framed, 'image/jpeg')
  return outPath
}

export function formatPriceBn(taka: number): string {
  return `৳${Math.round(taka).toLocaleString('bn-BD')}`
}

export function formatDiscountBn(percent: number): string {
  return `${Math.round(percent).toLocaleString('bn-BD')}% ছাড়`
}
