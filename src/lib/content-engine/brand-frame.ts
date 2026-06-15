import { randomUUID } from 'crypto'
import { agentStorageDownload, agentStorageUpload } from '@/agent/lib/storage'

export type BrandTheme = 'default' | 'eid' | 'puja' | 'boishakh' | 'winter'

const THEME_ACCENT: Record<BrandTheme, string> = {
  default: '#C9A84C',
  eid: '#1B6B3A',
  puja: '#B45309',
  boishakh: '#DC2626',
  winter: '#1E40AF',
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildFrameSvg(width: number, barHeight: number, opts: {
  productCode: string
  hook: string
  theme: BrandTheme
  footer?: boolean
}): string {
  const accent = THEME_ACCENT[opts.theme] ?? THEME_ACCENT.default
  const hook = escapeXml(opts.hook.slice(0, 48))
  const code = escapeXml(opts.productCode.slice(0, 24))
  const footer = opts.footer
    ? `<text x="24" y="${barHeight - 14}" fill="#E8E0C8" font-family="system-ui,sans-serif" font-size="13">Alma Lifestyle · অর্ডার ইনবক্সে মেসেজ করুন</text>`
    : ''
  return `<svg width="${width}" height="${barHeight}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="rgba(8,8,10,0.82)"/>
  <rect x="0" y="0" width="6" height="100%" fill="${accent}"/>
  <text x="24" y="34" fill="${accent}" font-family="system-ui,sans-serif" font-size="22" font-weight="700">ALMA</text>
  <text x="24" y="62" fill="#FAFAF8" font-family="system-ui,sans-serif" font-size="18" font-weight="700">${hook}</text>
  <text x="${width - 24}" y="34" fill="#A1A1AA" font-family="monospace" font-size="14" text-anchor="end">${code}</text>
  ${footer}
</svg>`
}

/**
 * Deterministic brand frame — logo layout + product code + hook via code (never AI text).
 */
export async function applyBrandFrame(
  imagePath: string,
  opts: {
    productCode: string
    hook?: string
    theme?: BrandTheme
    footer?: boolean
  },
): Promise<string> {
  const sharp = (await import('sharp')).default
  const buf = await agentStorageDownload(imagePath)
  const meta = await sharp(buf).metadata()
  const width = meta.width ?? 1080
  const height = meta.height ?? 1350
  const barHeight = Math.max(72, Math.round(height * 0.11))
  const hook = opts.hook ?? 'নতুন কালেকশন'
  const svg = buildFrameSvg(width, barHeight, {
    productCode: opts.productCode,
    hook,
    theme: opts.theme ?? 'default',
    footer: opts.footer ?? false,
  })

  const framed = await sharp(buf)
    .composite([{ input: Buffer.from(svg), top: height - barHeight, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer()

  const outPath = `content/framed/${opts.productCode}-${Date.now()}-${randomUUID().slice(0, 8)}.jpg`
  await agentStorageUpload(outPath, framed, 'image/jpeg')
  return outPath
}
