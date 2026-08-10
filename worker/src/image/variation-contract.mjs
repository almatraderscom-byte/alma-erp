export function normalizeVariationCount(value, max = 4) {
  const parsed = Math.floor(Number(value) || 1)
  return Math.min(max, Math.max(1, parsed))
}

export function variationPrompt(basePrompt, index, count) {
  if (index <= 1 || count <= 1) return String(basePrompt ?? '')
  return `${String(basePrompt ?? '')}\n\nVARIATION ${index} OF ${count}: Keep the requested subject, text, brand, and aspect ratio, but produce a clearly distinct composition, pose, lighting, or visual treatment. Do not make a collage and do not combine multiple variations into one image.`
}

export function partialVariationWarning(deliveredCount, requestedCount, failedVariation) {
  const delivered = Math.max(1, Math.floor(Number(deliveredCount) || 1))
  const requested = Math.max(delivered, Math.floor(Number(requestedCount) || delivered))
  const failed = Math.max(delivered + 1, Math.floor(Number(failedVariation) || delivered + 1))
  return `${delivered} of ${requested} images completed; variation ${failed} failed. Completed images were preserved — retry for the remaining variations.`
}
