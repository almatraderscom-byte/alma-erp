/**
 * CS7 — the mask contract for FLUX Fill precision edits.
 *
 * POLARITY (locked, fixture-tested here and in the worker adapter test):
 *   WHITE (255) = EDIT this pixel (Fill repaints it)
 *   BLACK (0)   = KEEP this pixel (protected, must survive untouched)
 *
 * The worker enforces the contract mechanically: the final artifact is a
 * protected composite — base×(1−mask) + fill×mask — so unmasked pixels are
 * unchanged BY CONSTRUCTION, with a pixel-diff assertion on top. Base image
 * and mask must have identical dimensions; the upload route validates this.
 */

export const MASK_EDIT_VALUE = 255
export const MASK_KEEP_VALUE = 0

/** Fal FLUX Fill list price: $0.05 per megapixel, rounded UP to whole MP. */
export const FLUX_FILL_USD_PER_MEGAPIXEL = 0.05

/** CS7 defaults (roadmap): precision work → no prompt rewriting, 1 image, PNG. */
export const FLUX_FILL_DEFAULTS = {
  enhancePrompt: false,
  numImages: 1,
  outputFormat: 'png',
  safetyTolerance: '2',
} as const

export type MaskPresetId =
  | 'replace_background'
  | 'remove_object'
  | 'repair_hand'
  | 'contact_shadow'
  | 'extend_canvas'
  | 'custom'

export type MaskPreset = {
  id: MaskPresetId
  labelBn: string
  /** English instruction sent to FLUX Fill; {detail} is the owner's addition */
  promptTemplate: string
  /** brush hint shown in the editor */
  hintBn: string
}

export const MASK_PRESETS: MaskPreset[] = [
  {
    id: 'replace_background',
    labelBn: 'ব্যাকগ্রাউন্ড বদলাও',
    promptTemplate:
      'Replace the masked background region with: {detail}. Keep the perspective, light direction and color temperature consistent with the untouched subject. Photorealistic, seamless transition at the mask boundary.',
    hintBn: 'মানুষ/পণ্য বাদ দিয়ে চারপাশের ব্যাকগ্রাউন্ড ব্রাশ করুন',
  },
  {
    id: 'remove_object',
    labelBn: 'অবজেক্ট/দাগ মুছাও',
    promptTemplate:
      'Remove everything inside the masked region and reconstruct a clean, natural continuation of the surrounding surface and lighting. {detail}',
    hintBn: 'যা মুছতে চান শুধু সেটুকু ব্রাশ করুন',
  },
  {
    id: 'repair_hand',
    labelBn: 'হাত/ছোট জায়গা ঠিক করো',
    promptTemplate:
      'Repair the masked area with anatomically correct, natural detail (correct fingers, proportions and skin texture), matching the person\'s skin tone, pose and scene lighting exactly. {detail}',
    hintBn: 'খারাপ হাত/আঙুল/ছোট ত্রুটির জায়গাটুকুই ব্রাশ করুন',
  },
  {
    id: 'contact_shadow',
    labelBn: 'কন্টাক্ট শ্যাডো যোগ করো',
    promptTemplate:
      'Add a soft, realistic contact shadow in the masked ground region, consistent with the scene\'s light direction and softness. Subtle and natural. {detail}',
    hintBn: 'পায়ের/পণ্যের নিচে মেঝের যে অংশে ছায়া পড়বে সেটুকু ব্রাশ করুন',
  },
  {
    id: 'extend_canvas',
    labelBn: 'ক্যানভাস বাড়াও',
    promptTemplate:
      'Extend the scene naturally into the masked border region — continue the background, floor and lighting seamlessly. {detail}',
    hintBn: 'ছবির কিনারার বাড়তি অংশ ব্রাশ করুন (Extend চাপলে অটো মাস্ক হয়)',
  },
  {
    id: 'custom',
    labelBn: 'নিজের প্রম্পট',
    promptTemplate: '{detail}',
    hintBn: 'যা বদলাতে চান সেই জায়গা ব্রাশ করে নিজের ভাষায় লিখুন',
  },
]

export function getMaskPreset(id: string | null | undefined): MaskPreset {
  return MASK_PRESETS.find((p) => p.id === id) ?? MASK_PRESETS[MASK_PRESETS.length - 1]
}

/** Build the final Fill prompt from a preset + owner detail text. */
export function buildFillPrompt(presetId: string | null | undefined, detail: string): string {
  const preset = getMaskPreset(presetId)
  const cleaned = (detail ?? '').trim()
  if (preset.id === 'custom' && !cleaned) {
    throw new Error('custom_prompt_required')
  }
  return preset.promptTemplate.replace('{detail}', cleaned).trim()
}

/** $0.05/MP rounded UP — mirrors worker cost-log (calcFluxFillCostUsd). */
export function estimateFluxFillCostUsd(widthPx: number, heightPx: number, numImages = 1): number {
  const w = Math.max(1, Math.floor(Number(widthPx) || 0))
  const h = Math.max(1, Math.floor(Number(heightPx) || 0))
  const megapixels = Math.max(1, Math.ceil((w * h) / 1_000_000))
  const n = Math.max(1, Math.floor(numImages))
  return Math.round(megapixels * FLUX_FILL_USD_PER_MEGAPIXEL * n * 1e6) / 1e6
}

/** Base and mask must match EXACTLY — Fill aligns masks per-pixel. */
export function assertMaskDimensionsMatch(
  base: { width: number; height: number },
  mask: { width: number; height: number },
): void {
  if (!base.width || !base.height || !mask.width || !mask.height) {
    throw new Error('mask_dimensions_unreadable')
  }
  if (base.width !== mask.width || base.height !== mask.height) {
    throw new Error(
      `mask_dimensions_mismatch: base ${base.width}x${base.height} vs mask ${mask.width}x${mask.height}`,
    )
  }
}

/**
 * Fraction of pixels marked EDIT (white) in a single-channel mask buffer.
 * Values ≥128 count as edit — brush anti-aliasing lands mid-gray at edges.
 */
export function maskCoverageRatio(gray: Uint8Array | Uint8ClampedArray): number {
  if (!gray.length) return 0
  let edit = 0
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] >= 128) edit++
  }
  return edit / gray.length
}

/** Guard against no-op or delete-everything masks before spending money. */
export function validateMaskCoverage(ratio: number): void {
  if (ratio <= 0.0005) throw new Error('mask_empty')
  if (ratio >= 0.98) throw new Error('mask_covers_everything')
}

/** Feather presets → blur radius in px, scaled to image size. */
export function featherRadiusPx(maxSidePx: number, feather: 'none' | 'soft' | 'wide'): number {
  if (feather === 'none') return 0
  const base = Math.max(2, Math.round(maxSidePx / (feather === 'soft' ? 256 : 96)))
  return Math.min(base, 48)
}
