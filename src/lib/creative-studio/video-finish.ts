/**
 * Phase V3 — motion-template Finishing for reels (the video twin of the image
 * Finishing tab). The owner picks templates and types the values (price, code,
 * CTA); this PURE planner turns them into an exact frame-timed overlay plan
 * that the Remotion composition on the VPS renders verbatim. Deterministic:
 * same inputs → same plan; all timing math lives here, unit-tested — the
 * React components only animate what the plan dictates.
 */

export const FINISH_FPS = 30

export type FinishTemplateInput = {
  /** animated price tag pop-up, e.g. "১২৫০" (taka display string) */
  pricePop?: { price: string }
  /** product code + optional name slide-in bar */
  lowerThird?: { code: string; name?: string }
  /** small ALMA logo watermark for the whole reel */
  logoWatermark?: boolean
  /** closing brand card with CTA (and optional code/price echo) */
  endCard?: { cta?: string; code?: string; price?: string }
  /** "অফার শেষ হতে X দিন" pulsing badge */
  countdown?: { days: number }
}

export type OverlayItem = {
  kind: 'price_pop' | 'lower_third' | 'logo_watermark' | 'end_card' | 'countdown'
  /** first frame (inclusive) */
  from: number
  durationInFrames: number
  props: Record<string, string | number | boolean>
}

export type OverlayPlan = {
  fps: number
  width: number
  height: number
  durationInFrames: number
  /** true when the brand logo file is bundled into the render (watermark/end card) */
  needsLogo: boolean
  items: OverlayItem[]
}

export const DEFAULT_CTA_BN = 'অর্ডার করতে ইনবক্স করুন'

const clampText = (s: string, max: number) => s.trim().slice(0, max)
const sec = (s: number) => Math.round(s * FINISH_FPS)

/**
 * Build the frame-exact overlay plan.
 * Hard rules (no taste, no randomness):
 *  - end card owns the last 2.5s (shrinks to 25% of very short reels)
 *  - price pop enters at 15% in and stays until the end card
 *  - lower third slides in at 0.5s and holds 4s (clamped to the reel)
 *  - watermark spans the whole reel; countdown runs 1s → end card
 */
export function buildOverlayPlan(input: {
  durationSec: number
  width: number
  height: number
  templates: FinishTemplateInput
}): OverlayPlan {
  const { templates } = input
  const durationSec = Number(input.durationSec)
  if (!Number.isFinite(durationSec) || durationSec < 3) throw new Error('invalid_duration')
  const width = Math.round(input.width)
  const height = Math.round(input.height)
  if (!(width > 0 && height > 0)) throw new Error('invalid_dimensions')

  const total = sec(durationSec)
  const items: OverlayItem[] = []

  const endCardFrames = templates.endCard ? Math.min(sec(2.5), Math.round(total * 0.25)) : 0
  const endCardFrom = total - endCardFrames

  if (templates.logoWatermark) {
    items.push({
      kind: 'logo_watermark',
      from: 0,
      durationInFrames: endCardFrames > 0 ? endCardFrom : total,
      props: {},
    })
  }

  if (templates.lowerThird?.code?.trim()) {
    const from = Math.min(sec(0.5), Math.max(0, endCardFrom - sec(1)))
    const dur = Math.min(sec(4), Math.max(sec(1.5), endCardFrom - from))
    items.push({
      kind: 'lower_third',
      from,
      durationInFrames: dur,
      props: {
        code: clampText(templates.lowerThird.code, 24),
        name: clampText(templates.lowerThird.name ?? '', 40),
      },
    })
  }

  if (templates.pricePop?.price?.trim()) {
    const from = Math.min(sec(durationSec * 0.15), Math.max(0, endCardFrom - sec(2)))
    items.push({
      kind: 'price_pop',
      from,
      durationInFrames: Math.max(sec(1.5), endCardFrom - from),
      props: { price: clampText(templates.pricePop.price, 16) },
    })
  }

  if (templates.countdown && Number.isFinite(templates.countdown.days) && templates.countdown.days > 0) {
    const from = Math.min(sec(1), Math.max(0, endCardFrom - sec(2)))
    items.push({
      kind: 'countdown',
      from,
      durationInFrames: Math.max(sec(1.5), endCardFrom - from),
      props: { days: Math.min(99, Math.round(templates.countdown.days)) },
    })
  }

  if (templates.endCard) {
    items.push({
      kind: 'end_card',
      from: endCardFrom,
      durationInFrames: endCardFrames,
      props: {
        cta: clampText(templates.endCard.cta ?? '', 60) || DEFAULT_CTA_BN,
        code: clampText(templates.endCard.code ?? '', 24),
        price: clampText(templates.endCard.price ?? '', 16),
      },
    })
  }

  if (items.length === 0) throw new Error('no_templates_selected')

  return {
    fps: FINISH_FPS,
    width,
    height,
    durationInFrames: total,
    needsLogo: Boolean(templates.logoWatermark || templates.endCard),
    items,
  }
}
