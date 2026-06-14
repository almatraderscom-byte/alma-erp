/**
 * Simple, explainable demand forecast — run-rate based, no ML.
 * daysOfStock = currentStock / dailyRunRate
 * Suggests reorder when daysOfStock < (leadTimeDays + safetyDays).
 */

export const DEFAULT_LEAD_DAYS = 7
export const SAFETY_DAYS = 3

export type ForecastProductInput = {
  id: string
  name: string
  currentStock: number
  reorderLevel?: number
  sales30d?: number
  sales90d?: number
  seasonalTag?: string
  tags?: string[]
}

export type ReorderSuggestion = {
  id: string
  name: string
  currentStock: number
  dailyRate: number
  daysOfStock: number
  suggestedQty: number
  urgency: 'high' | 'normal'
  reason: string
}

/** Seasonal multiplier — bump demand near known high-sales windows. */
export function seasonalMultiplier(today = new Date(), tags: string[] = []): number {
  const month = today.getMonth() + 1
  let mult = 1.0

  // Approximate BD retail peaks (refine via settings/tags later)
  if (month >= 3 && month <= 5) mult = 1.15
  if (month >= 5 && month <= 7) mult = 1.1

  const tagSet = new Set(tags.map((t) => t.toLowerCase()))
  if (tagSet.has('eid_season') || tagSet.has('eid_adha_season')) mult *= 1.2
  if (['panjabi', 'family', 'kids'].some((t) => tagSet.has(t))) mult *= 1.1

  return mult
}

/**
 * @returns reorder suggestions sorted by urgency (fewest days of stock first)
 */
export function buildReorderSuggestions(
  products: ForecastProductInput[],
  opts: { leadDays?: number; today?: Date; safetyDays?: number } = {},
): ReorderSuggestion[] {
  const leadDays = opts.leadDays ?? DEFAULT_LEAD_DAYS
  const safetyDays = opts.safetyDays ?? SAFETY_DAYS
  const today = opts.today ?? new Date()
  const out: ReorderSuggestion[] = []

  for (const p of products) {
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
