export function normalizeVariationCount(value, max = 4) {
  const parsed = Math.floor(Number(value) || 1)
  return Math.min(max, Math.max(1, parsed))
}

export function variationPrompt(basePrompt, index, count) {
  if (index <= 1 || count <= 1) return String(basePrompt ?? '')
  return `${String(basePrompt ?? '')}\n\nVARIATION ${index} OF ${count}: Keep the requested subject, text, brand, and aspect ratio, but produce a clearly distinct composition, pose, lighting, or visual treatment. Do not make a collage and do not combine multiple variations into one image.`
}
