export const GPT_IMAGE_2_RATES_USD_PER_M = Object.freeze({
  textInput: 5,
  imageInput: 8,
  imageOutput: 30,
})

const QUALITY_GRID = Object.freeze({ low: 16, medium: 48, high: 96 })

/** Mirrors OpenAI's published GPT Image 2 output-token calculator. */
export function gptImage2OutputTokens(width, height, quality) {
  const longEdge = Math.max(width, height)
  const shortEdge = Math.min(width, height)
  const longGrid = QUALITY_GRID[quality]
  if (!longGrid) throw new Error(`unsupported GPT Image 2 quality: ${quality}`)
  const shortGrid = Math.round(longGrid * shortEdge / longEdge)
  const widthGrid = width >= height ? longGrid : shortGrid
  const heightGrid = width >= height ? shortGrid : longGrid
  return Math.ceil(widthGrid * heightGrid * (2_000_000 + width * height) / 4_000_000)
}

export function gptImage2OutputCostUsd(width, height, quality) {
  return gptImage2OutputTokens(width, height, quality)
    * GPT_IMAGE_2_RATES_USD_PER_M.imageOutput / 1_000_000
}

/** Settle from provider-reported usage so edits include both reference images. */
export function gptImage2UsageCostUsd(usage) {
  const details = usage?.input_tokens_details
  const textInput = Number(details?.text_tokens)
  const imageInput = Number(details?.image_tokens)
  const imageOutput = Number(usage?.output_tokens)
  if (![textInput, imageInput, imageOutput].every(Number.isFinite)) return null
  return (
    textInput * GPT_IMAGE_2_RATES_USD_PER_M.textInput
    + imageInput * GPT_IMAGE_2_RATES_USD_PER_M.imageInput
    + imageOutput * GPT_IMAGE_2_RATES_USD_PER_M.imageOutput
  ) / 1_000_000
}
