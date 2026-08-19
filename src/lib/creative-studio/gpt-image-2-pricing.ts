export type GptImage2Quality = 'low' | 'medium' | 'high'

const QUALITY_GRID: Readonly<Record<GptImage2Quality, number>> = {
  low: 16,
  medium: 48,
  high: 96,
}

export const GPT_IMAGE_2_TEXT_INPUT_USD_PER_M = 5
export const GPT_IMAGE_2_IMAGE_INPUT_USD_PER_M = 8
export const GPT_IMAGE_2_IMAGE_OUTPUT_USD_PER_M = 30
export const GPT_IMAGE_2_PRICING_VERIFIED_AT = '2026-08-19'

/** Mirrors OpenAI's published GPT Image 2 output-token calculator. */
export function gptImage2OutputTokens(
  width: number,
  height: number,
  quality: GptImage2Quality,
): number {
  const longEdge = Math.max(width, height)
  const shortEdge = Math.min(width, height)
  const longGrid = QUALITY_GRID[quality]
  const shortGrid = Math.round(longGrid * shortEdge / longEdge)
  const widthGrid = width >= height ? longGrid : shortGrid
  const heightGrid = width >= height ? shortGrid : longGrid
  return Math.ceil(
    widthGrid * heightGrid * (2_000_000 + width * height) / 4_000_000,
  )
}

export function gptImage2OutputCostUsd(
  width: number,
  height: number,
  quality: GptImage2Quality,
): number {
  return gptImage2OutputTokens(width, height, quality)
    * GPT_IMAGE_2_IMAGE_OUTPUT_USD_PER_M / 1_000_000
}
