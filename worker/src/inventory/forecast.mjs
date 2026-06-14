/**
 * Worker mirror of src/lib/inventory-forecast.ts — keep logic in sync.
 */
export const DEFAULT_LEAD_DAYS = 7
export const SAFETY_DAYS = 3

/** Seasonal multiplier — bump demand near known high-sales windows. */
export function seasonalMultiplier(today = new Date(), tags = []) {
  const month = today.getMonth() + 1
  let mult = 1.0
  if (month >= 3 && month <= 5) mult = 1.15
  if (month >= 5 && month <= 7) mult = 1.1
  const tagSet = new Set(tags.map((t) => String(t).toLowerCase()))
  if (tagSet.has('eid_season') || tagSet.has('eid_adha_season')) mult *= 1.2
  if (['panjabi', 'family', 'kids'].some((t) => tagSet.has(t))) mult *= 1.1
  return mult
}

/**
 * @param {Array} products items with { id, name, currentStock, reorderLevel, sales30d, sales90d, seasonalTag?, tags? }
 * @returns {Array} reorder suggestions sorted by urgency
 */
export function buildReorderSuggestions(products, opts = {}) {
  const leadDays = opts.leadDays ?? DEFAULT_LEAD_DAYS
  const safetyDays = opts.safetyDays ?? SAFETY_DAYS
  const today = opts.today ?? new Date()
  const out = []

  for (const p of products ?? []) {
    const rate30 = (p.sales30d ?? 0) / 30
    const rate90 = (p.sales90d ?? 0) / 90
    let dailyRate = rate30 * 0.7 + rate90 * 0.3
    const tags = [...(p.tags ?? []), ...(p.seasonalTag ? [p.seasonalTag] : [])]
    dailyRate *= seasonalMultiplier(today, tags)

    if (dailyRate <= 0) continue

    const daysOfStock = p.currentStock / dailyRate
    const threshold = leadDays + safetyDays

    if (daysOfStock < threshold) {
      const suggestedQty = Math.ceil(dailyRate * (leadDays + 30) - p.currentStock)
      const roundedRate = Math.round(dailyRate * 10) / 10
      out.push({
        id: p.id,
        name: p.name,
        currentStock: p.currentStock,
        dailyRate: roundedRate,
        daysOfStock: Math.round(daysOfStock * 10) / 10,
        suggestedQty: Math.max(suggestedQty, 1),
        urgency: daysOfStock < leadDays ? 'high' : 'normal',
        reason: `দিনে ~${roundedRate}টি বিক্রি, স্টক আর ~${Math.round(daysOfStock)} দিন চলবে`,
      })
    }
  }

  return out.sort((a, b) => a.daysOfStock - b.daysOfStock)
}
