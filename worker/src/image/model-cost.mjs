/** Gemini has no separate quality switch in this request. Billing follows the
 * actual selected model, even when the surrounding action tier is `pro`. */
export function geminiCostTierForImageModel(modelName) {
  return modelName === 'gemini-3.1-flash-image' ? 'standard' : 'pro'
}
