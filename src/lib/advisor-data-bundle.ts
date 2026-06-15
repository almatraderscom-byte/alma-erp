/**
 * Shared advisor data bundle — used by advisor_data_bundle tool and daily strategist.
 */
import { buildWeeklyStrategicReview } from '@/lib/weekly-strategic-data'
import { analyzeFinancials } from '@/lib/financial-intelligence'
import { buildMarketingIntel } from '@/lib/content-intelligence'
import { getInventoryWithSales } from '@/lib/inventory-with-sales'
import { buildReorderSuggestions } from '@/lib/inventory-forecast'
import { segmentCustomers } from '@/lib/customer-intelligence'
import { analyzePricing } from '@/lib/pricing-insight'

export type AdvisorTopic = 'pricing' | 'marketing' | 'financial' | 'staffing' | 'product_focus' | 'general'

export async function buildAdvisorDataBundle(
  topic: AdvisorTopic,
  focusEntity?: string,
): Promise<Record<string, unknown>> {
  const bundle: Record<string, unknown> = { topic, focusEntity }

  switch (topic) {
    case 'pricing': {
      const [pricing, financial] = await Promise.all([
        analyzePricing().catch(() => null),
        analyzeFinancials({ days: 30 }).catch(() => null),
      ])
      bundle.pricing = pricing
      bundle.financial = financial
      break
    }
    case 'marketing': {
      const [marketing, strategic] = await Promise.all([
        buildMarketingIntel(focusEntity).catch(() => null),
        buildWeeklyStrategicReview().catch(() => null),
      ])
      bundle.marketing = marketing
      bundle.strategic = strategic?.data
      break
    }
    case 'financial': {
      const [financial, strategic] = await Promise.all([
        analyzeFinancials({ days: 30 }).catch(() => null),
        buildWeeklyStrategicReview().catch(() => null),
      ])
      bundle.financial = financial
      bundle.strategic = strategic?.data
      break
    }
    case 'staffing': {
      const strategic = await buildWeeklyStrategicReview().catch(() => null)
      bundle.strategic = strategic?.data
      break
    }
    case 'product_focus': {
      const [products, segments, marketing] = await Promise.all([
        getInventoryWithSales().catch(() => null),
        segmentCustomers().catch(() => null),
        buildMarketingIntel(focusEntity).catch(() => null),
      ])
      const suggestions =
        products != null ? buildReorderSuggestions(products, { leadDays: 7 }) : null
      bundle.reorderSuggestions =
        suggestions != null
          ? { count: suggestions.length, leadDays: 7, suggestions: suggestions.slice(0, 15) }
          : null
      bundle.customerSegments =
        segments != null
          ? {
              winBackCount: segments.winBack.length,
              loyalCount: segments.loyal.length,
              atRiskCount: segments.atRisk.length,
              newRecentCount: segments.newRecent.length,
              winBack: segments.winBack.slice(0, 10),
              atRisk: segments.atRisk.slice(0, 8),
            }
          : null
      bundle.marketing = marketing
      break
    }
    case 'general':
    default: {
      const [strategic, financial] = await Promise.all([
        buildWeeklyStrategicReview().catch(() => null),
        analyzeFinancials({ days: 30 }).catch(() => null),
      ])
      bundle.strategic = strategic?.data
      bundle.financial = financial
      break
    }
  }

  return bundle
}

/** Cross-domain snapshot for the daily strategist pass. */
export async function buildStrategistDataBundle(): Promise<Record<string, unknown>> {
  const [general, marketing, productFocus] = await Promise.all([
    buildAdvisorDataBundle('general'),
    buildAdvisorDataBundle('marketing'),
    buildAdvisorDataBundle('product_focus'),
  ])
  return { general, marketing, productFocus }
}
