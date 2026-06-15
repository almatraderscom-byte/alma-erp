import { BRAND } from '@/lib/content-engine/brand-identity'
import type { ProductAsset } from '@/lib/content-engine/generate-variants'

export type VideoAspect = '9:16' | '1:1' | '16:9'
export type VideoVibe = 'premium' | 'festival' | 'offer' | 'lifestyle'

const VIBE_MOTION: Record<VideoVibe, string> = {
  premium:
    'Slow cinematic push-in, gentle camera drift, fabric drapes naturally with soft movement. Premium ALMA fashion reel — calm, confident, no frantic motion.',
  festival:
    'Warm golden-hour Bangladeshi festive mood, subtle celebratory ambience, model turns slightly to show embroidery, fabric catches light naturally.',
  offer:
    'Energetic but still premium — quick gentle zoom on garment details, confident model micro-movement, bright clean lighting, retail-ready.',
  lifestyle:
    'Candid lifestyle motion — natural walk or turn in a relatable Bangladeshi setting, authentic and unposed, fabric moves realistically.',
}

const GARMENT_GUARD =
  'CRITICAL: Keep garment shape, embroidery, collar, and fabric pattern EXACTLY as the reference image — no warping, melting, or redesign. ' +
  'Motion must be subtle (max 6–8 seconds). Face and body proportions stay natural for a Bangladeshi model. ' +
  'No text overlays in the generated video — brand marks added separately if needed.'

export function buildVideoBrief(
  product: ProductAsset,
  opts?: {
    vibe?: VideoVibe
    aspect?: VideoAspect
    durationSec?: number
    extraMotion?: string
  },
): { prompt: string; aspect: VideoAspect; durationSec: number } {
  const vibe = opts?.vibe ?? 'premium'
  const aspect = opts?.aspect ?? '9:16'
  const durationSec = Math.min(Math.max(opts?.durationSec ?? 6, 4), 8)

  const garment = [product.category, product.fabric, product.name].filter(Boolean).join(', ')
  const motion = VIBE_MOTION[vibe]
  const extra = opts?.extraMotion?.trim() ? ` ${opts.extraMotion.trim()}` : ''

  const prompt =
    `${motion} ` +
    `Product: ${product.productCode}${garment ? ` — ${garment}` : ''}. ` +
    `${BRAND.name} Lifestyle Bangladesh fashion reel. ` +
    'Photorealistic, shallow depth of field, soft natural light, e-commerce quality. ' +
    GARMENT_GUARD +
    extra

  return { prompt, aspect, durationSec }
}

export function estimateReelCostUsd(durationSec: number): number {
  return Math.round(durationSec * 0.15 * 1_000_000) / 1_000_000
}

export function estimateReelCostBdt(durationSec: number, usdToBdt = 125): number {
  return Math.round(estimateReelCostUsd(durationSec) * usdToBdt)
}
