/**
 * Shared geometry for the full-bleed "lifestyle poster" finishing layout.
 *
 * SINGLE SOURCE OF TRUTH — this pure module (no node/fs imports) is consumed by
 * BOTH sides so they can never drift:
 *   • the server (`brand-frame.ts`) turns a layout into the SVG it rasterises with
 *     sharp for the final crisp image, and
 *   • the browser drag/resize editor (`LifestyleEditor.tsx`) seeds itself from the
 *     exact same auto positions, so what the owner drags is what gets rendered.
 *
 * All coordinates are in the 1080×1080 design space. Text elements store their
 * anchor point (x = the anchored edge per `justify`, y = the FIRST baseline) so a
 * block keeps its justification when moved. The editor sends back only geometry
 * (positions / sizes); text content + wrapping stay server-authoritative.
 */

export const LIFESTYLE_SIZE = 1080
export const LIFESTYLE_PAD = 64

/** Colour tokens the editor needs without importing the server-only brand module. */
export const LIFESTYLE_COLORS = {
  cream: '#F5EBDD',
  charcoal: '#2A2622',
} as const

/** Browser font-family stacks (mirror BRAND_FONT; AlmaSerif/AlmaDisplay are
 * registered via @font-face pointing at /fonts/brand/*.ttf in the editor). */
export const LIFESTYLE_FONT = {
  serif: "'AlmaSerif', 'Noto Serif Bengali', serif",
  display: "'AlmaDisplay', 'Playfair Display', serif",
} as const

export const DEFAULT_OFFER = 'অফার প্রাইস জানতে ইনবক্স করুন'
export const LIFESTYLE_EST = 'EST. 2019 · DHAKA'

/**
 * Client-safe theme tokens for the editor preview — MIRRORS `THEME_ACCENT` in the
 * server-only `brand-identity.ts` (which can't be imported into a client bundle
 * because it pulls in `fs`). Keep these values in sync with that map.
 */
export const LIFESTYLE_THEME_TOKENS: Record<string, { accent: string; eyebrow: string }> = {
  default: { accent: '#C89B3C', eyebrow: 'নতুন এসেছে' },
  eid: { accent: '#6B2737', eyebrow: 'ঈদ স্পেশাল' },
  puja: { accent: '#C97D5D', eyebrow: 'উৎসব কালেকশন' },
  boishakh: { accent: '#2D5F4F', eyebrow: 'বৈশাখী কালেকশন' },
  winter: { accent: '#2D5F4F', eyebrow: 'শীত কালেকশন' },
}

export type Justify = 'start' | 'middle' | 'end'
export type ColorToken = 'cream' | 'accent'
export type FontToken = 'serif' | 'display'

export type TextEl = {
  id: 'eyebrow' | 'headline' | 'offer' | 'est'
  kind: 'text'
  lines: string[]
  /** anchor x (left edge for start, centre for middle, right edge for end) */
  x: number
  /** first-line baseline y */
  y: number
  size: number
  leading: number
  justify: Justify
  color: ColorToken
  font: FontToken
  weight: number
  letterSpacing: number
}

export type BadgeEl = {
  id: 'codeBadge'
  kind: 'badge'
  cx: number
  cy: number
  r: number
  /** code text size */
  size: number
  code: string
  label: string
  labelSize: number
  /** label baseline offset above the ring centre (negative = up) */
  labelDy: number
}

export type RuleEl = { id: 'rule'; kind: 'rule'; x: number; y: number; w: number; h: number }
export type MonogramEl = { id: 'monogram'; kind: 'monogram'; cx: number; cy: number; r: number; size: number; letter: string }
/** Logo anchored by its top-left; height follows the asset's aspect ratio. */
export type LogoEl = { id: 'logo'; kind: 'logo'; x: number; y: number; w: number }

export type LifestyleLayout = {
  eyebrow: TextEl
  headline: TextEl
  offer: TextEl
  est: TextEl
  codeBadge: BadgeEl
  rule: RuleEl
  monogram: MonogramEl
  logo: LogoEl
}

/**
 * Greedy word-wrap (librsvg has no auto-wrap; the editor mirrors it). Packs words
 * up to ~maxChars per line; on the final allowed line it keeps appending so
 * nothing is dropped. Bangla clusters are wide, so callers pass a small maxChars.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
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

export type LifestyleText = {
  eyebrow: string
  headline: string
  offer: string
  code: string
  /** EST line (defaults to brand value, passed in to keep this module pure) */
  est: string
}

/**
 * Compute the default ("auto-finish") positions. These numbers reproduce the
 * owner-approved reference layout EXACTLY — keep them in sync with any tweak the
 * server makes, since both sides start here.
 */
export function computeAutoLayout(t: LifestyleText): LifestyleLayout {
  const S = LIFESTYLE_SIZE
  const pad = LIFESTYLE_PAD

  const headlineLines = wrapText(t.headline, 15, 2)
  const offerLines = wrapText(t.offer, 18, 2)

  // top-right CODE ring
  const circleR = 46
  const circleCx = S - pad - circleR // 970
  const circleCy = 124
  const code = t.code.slice(0, 16)
  // Size the code to actually fit inside the ring (Bangla glyphs are wide).
  const codeSize = code.length > 9 ? 14 : code.length > 6 ? 17 : 22

  // bottom-left block, laid out bottom-up from the mustard rule
  const ruleY = 1018
  const hlSize = 54
  const hlLeading = 62
  const nHl = Math.max(1, headlineLines.length)
  const lastHlBaseline = ruleY - 16 // 1002
  const firstHlBaseline = lastHlBaseline - (nHl - 1) * hlLeading
  const eyebrowBaseline = firstHlBaseline - 46

  // bottom-right offer block (right-aligned)
  const offerRight = S - pad // 1016
  const offerSize = 30
  const offerLeading = 40
  const nOf = Math.max(1, offerLines.length)
  const offerLastBaseline = 998
  const offerFirstBaseline = offerLastBaseline - (nOf - 1) * offerLeading

  return {
    eyebrow: {
      id: 'eyebrow', kind: 'text', lines: t.eyebrow ? [t.eyebrow] : [],
      x: pad, y: eyebrowBaseline, size: 27, leading: 34, justify: 'start',
      color: 'accent', font: 'serif', weight: 400, letterSpacing: 0,
    },
    headline: {
      id: 'headline', kind: 'text', lines: headlineLines,
      x: pad, y: firstHlBaseline, size: hlSize, leading: hlLeading, justify: 'start',
      color: 'cream', font: 'serif', weight: 700, letterSpacing: 0,
    },
    offer: {
      id: 'offer', kind: 'text', lines: offerLines,
      x: offerRight, y: offerFirstBaseline, size: offerSize, leading: offerLeading, justify: 'end',
      color: 'cream', font: 'serif', weight: 400, letterSpacing: 0,
    },
    est: {
      id: 'est', kind: 'text', lines: t.est ? [t.est] : [],
      x: Math.round(S / 2), y: 1048, size: 16, leading: 20, justify: 'middle',
      color: 'accent', font: 'display', weight: 400, letterSpacing: 2,
    },
    codeBadge: {
      id: 'codeBadge', kind: 'badge', cx: circleCx, cy: circleCy, r: circleR,
      size: codeSize, code, label: 'CODE', labelSize: 17, labelDy: -66,
    },
    rule: { id: 'rule', kind: 'rule', x: pad, y: ruleY, w: 74, h: 3 },
    monogram: { id: 'monogram', kind: 'monogram', cx: S - pad + 4, cy: 1034, r: 18, size: 18, letter: 'A' },
    logo: { id: 'logo', kind: 'logo', x: 60, y: 54, w: 280 },
  }
}

/** Geometry overrides the editor sends back (only the numbers it can change). */
export type LifestyleLayoutOverrides = {
  eyebrow?: { x?: number; y?: number; size?: number }
  headline?: { x?: number; y?: number; size?: number; leading?: number }
  offer?: { x?: number; y?: number; size?: number; leading?: number }
  est?: { x?: number; y?: number; size?: number }
  codeBadge?: { cx?: number; cy?: number; r?: number; size?: number }
  rule?: { x?: number; y?: number; w?: number }
  monogram?: { cx?: number; cy?: number; r?: number; size?: number }
  logo?: { x?: number; y?: number; w?: number }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback
}

/**
 * Overlay validated geometry overrides on top of the auto layout. Every value is
 * clamped to a sane range so a malformed client payload can't push text off-canvas
 * or request a 9000px font.
 */
export function applyLayoutOverrides(
  base: LifestyleLayout,
  ov?: LifestyleLayoutOverrides | null,
): LifestyleLayout {
  if (!ov) return base
  const S = LIFESTYLE_SIZE
  const POS = [-200, S + 200] as const
  return {
    ...base,
    eyebrow: { ...base.eyebrow,
      x: num(ov.eyebrow?.x, base.eyebrow.x, POS[0], POS[1]),
      y: num(ov.eyebrow?.y, base.eyebrow.y, POS[0], POS[1]),
      size: num(ov.eyebrow?.size, base.eyebrow.size, 10, 120) },
    headline: { ...base.headline,
      x: num(ov.headline?.x, base.headline.x, POS[0], POS[1]),
      y: num(ov.headline?.y, base.headline.y, POS[0], POS[1]),
      size: num(ov.headline?.size, base.headline.size, 14, 160),
      leading: num(ov.headline?.leading, base.headline.leading, 14, 200) },
    offer: { ...base.offer,
      x: num(ov.offer?.x, base.offer.x, POS[0], POS[1]),
      y: num(ov.offer?.y, base.offer.y, POS[0], POS[1]),
      size: num(ov.offer?.size, base.offer.size, 10, 120),
      leading: num(ov.offer?.leading, base.offer.leading, 12, 160) },
    est: { ...base.est,
      x: num(ov.est?.x, base.est.x, POS[0], POS[1]),
      y: num(ov.est?.y, base.est.y, POS[0], POS[1]),
      size: num(ov.est?.size, base.est.size, 8, 80) },
    codeBadge: { ...base.codeBadge,
      cx: num(ov.codeBadge?.cx, base.codeBadge.cx, POS[0], POS[1]),
      cy: num(ov.codeBadge?.cy, base.codeBadge.cy, POS[0], POS[1]),
      r: num(ov.codeBadge?.r, base.codeBadge.r, 20, 160),
      size: num(ov.codeBadge?.size, base.codeBadge.size, 8, 80) },
    rule: { ...base.rule,
      x: num(ov.rule?.x, base.rule.x, POS[0], POS[1]),
      y: num(ov.rule?.y, base.rule.y, POS[0], POS[1]),
      w: num(ov.rule?.w, base.rule.w, 10, 600) },
    monogram: { ...base.monogram,
      cx: num(ov.monogram?.cx, base.monogram.cx, POS[0], POS[1]),
      cy: num(ov.monogram?.cy, base.monogram.cy, POS[0], POS[1]),
      r: num(ov.monogram?.r, base.monogram.r, 8, 80),
      size: num(ov.monogram?.size, base.monogram.size, 8, 80) },
    logo: { ...base.logo,
      x: num(ov.logo?.x, base.logo.x, POS[0], POS[1]),
      y: num(ov.logo?.y, base.logo.y, POS[0], POS[1]),
      w: num(ov.logo?.w, base.logo.w, 60, 700) },
  }
}
