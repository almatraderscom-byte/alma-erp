import type { AgentTool } from './registry'

type AdvisorTopic = 'pricing' | 'marketing' | 'financial' | 'staffing' | 'product_focus' | 'general'

const advisor_data_bundle: AgentTool = {
  name: 'advisor_data_bundle',
  description:
    'Gathers a bundle of relevant ALMA business data for an advisory question — use this when the owner asks ' +
    '"ki kora uchit", "advice din", "strategy ki hobe", pricing/marketing/staffing/focus decisions. Pick the ' +
    'topic closest to the question. Returns multiple data sources in one call to avoid repeated tool calls. ' +
    'After reviewing, follow the advisor framework: situation → 2-3 options with tradeoffs → recommendation → ' +
    'action proposal (via the relevant existing tool, owner-approved).',
  input_schema: {
    type: 'object' as const,
    properties: {
      topic: {
        type: 'string',
        enum: ['pricing', 'marketing', 'financial', 'staffing', 'product_focus', 'general'],
        description:
          'pricing = analyze_pricing + financial health + competitor context if relevant; ' +
          'marketing = marketing intel + strategic review + SEO if relevant; ' +
          'financial = financial health + strategic review; ' +
          'staffing = staff tasks/profiles + strategic review; ' +
          'product_focus = reorder suggestions + customer segments + marketing intel; ' +
          'general = strategic review + financial health + recall knowledge',
      },
      focusEntity: { type: 'string', description: 'Optional — a specific product/SKU/staff name the question is about' },
    },
    required: ['topic'],
  },
  handler: async (input) => {
    const topic = String(input.topic ?? 'general') as AdvisorTopic
    const focusEntity = input.focusEntity ? String(input.focusEntity) : undefined
    const bundle: Record<string, unknown> = { topic, focusEntity }

    try {
      switch (topic) {
        case 'pricing': {
          const { analyzePricing } = await import('@/lib/pricing-insight')
          const { analyzeFinancials } = await import('@/lib/financial-intelligence')
          const [pricing, financial] = await Promise.all([
            analyzePricing().catch(() => null),
            analyzeFinancials({ days: 30 }).catch(() => null),
          ])
          bundle.pricing = pricing
          bundle.financial = financial
          break
        }
        case 'marketing': {
          const { buildMarketingIntel } = await import('@/lib/content-intelligence')
          const { buildWeeklyStrategicReview } = await import('@/lib/weekly-strategic-data')
          const [marketing, strategic] = await Promise.all([
            buildMarketingIntel(focusEntity).catch(() => null),
            buildWeeklyStrategicReview().catch(() => null),
          ])
          bundle.marketing = marketing
          bundle.strategic = strategic?.data
          break
        }
        case 'financial': {
          const { analyzeFinancials } = await import('@/lib/financial-intelligence')
          const { buildWeeklyStrategicReview } = await import('@/lib/weekly-strategic-data')
          const [financial, strategic] = await Promise.all([
            analyzeFinancials({ days: 30 }).catch(() => null),
            buildWeeklyStrategicReview().catch(() => null),
          ])
          bundle.financial = financial
          bundle.strategic = strategic?.data
          break
        }
        case 'staffing': {
          const { buildWeeklyStrategicReview } = await import('@/lib/weekly-strategic-data')
          const strategic = await buildWeeklyStrategicReview().catch(() => null)
          bundle.strategic = strategic?.data
          break
        }
        case 'product_focus': {
          const { getInventoryWithSales } = await import('@/lib/inventory-with-sales')
          const { buildReorderSuggestions } = await import('@/lib/inventory-forecast')
          const { segmentCustomers } = await import('@/lib/customer-intelligence')
          const { buildMarketingIntel } = await import('@/lib/content-intelligence')
          const [products, segments, marketing] = await Promise.all([
            getInventoryWithSales().catch(() => null),
            segmentCustomers().catch(() => null),
            buildMarketingIntel(focusEntity).catch(() => null),
          ])
          const suggestions =
            products != null ? buildReorderSuggestions(products, { leadDays: 7 }) : null
          bundle.reorderSuggestions =
            suggestions != null
              ? {
                  count: suggestions.length,
                  leadDays: 7,
                  suggestions,
                }
              : null
          bundle.customerSegments =
            segments != null
              ? {
                  winBackCount: segments.winBack.length,
                  loyalCount: segments.loyal.length,
                  atRiskCount: segments.atRisk.length,
                  newRecentCount: segments.newRecent.length,
                  winBack: segments.winBack.slice(0, 20),
                  loyal: segments.loyal.slice(0, 10),
                  atRisk: segments.atRisk.slice(0, 10),
                  newRecent: segments.newRecent.slice(0, 10),
                }
              : null
          bundle.marketing = marketing
          break
        }
        case 'general':
        default: {
          const { buildWeeklyStrategicReview } = await import('@/lib/weekly-strategic-data')
          const { analyzeFinancials } = await import('@/lib/financial-intelligence')
          const [strategic, financial] = await Promise.all([
            buildWeeklyStrategicReview().catch(() => null),
            analyzeFinancials({ days: 30 }).catch(() => null),
          ])
          bundle.strategic = strategic?.data
          bundle.financial = financial
          break
        }
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }

    return { success: true, data: bundle }
  },
}

export const ADVISOR_TOOLS: AgentTool[] = [advisor_data_bundle]

export const ADVISOR_ROLE_PROMPT = `
## ADVISOR MODE — "ki kora uchit" প্রশ্নের জন্য
যখন owner সিদ্ধান্ত/পরামর্শ চান (pricing, marketing, staffing, product focus, general strategy), নিচের framework follow করুন:

1. **advisor_data_bundle** কল করুন (topic বেছে নিন) — প্রাসঙ্গিক ডেটা একসাথে পান।
2. প্রয়োজনে recall_business_knowledge (accumulated learnings) এবং — শুধু যদি genuinely দরকার হয় — web_research/research_competitor/research_seo_keywords (external context, credit খরচ হয়, sparingly)।
3. উত্তর গঠন করুন:
   - **পরিস্থিতি**: 1-2 লাইনে ডেটা কী বলছে।
   - **অপশন**: ২-৩টি concrete option, প্রতিটার tradeoff (যেমন "A: discount দিলে sales বাড়বে কিন্তু margin কমবে; B: bundle অফার...")।
   - **সুপারিশ**: কোনটা best এবং কেন — ডেটা-ভিত্তিক reasoning, generic "ভালো লাগছে" না।
   - **অ্যাকশন**: যদি সুপারিশে কোনো change (price/task/ad budget/website) থাকে, সেই tool কল করে owner-approval card তৈরি করুন (update_product_web, pause_campaign/update_campaign_budget, add_staff_task_now, ইত্যাদি)। নিজে কখনো execute করবেন না — proposal পর্যন্ত।
4. **Honest hedging**: ডেটা অসম্পূর্ণ/ambiguous হলে স্পষ্ট বলুন — "এই সিদ্ধান্তের জন্য X ডেটা নেই, তাই..." বরং অতি-আত্মবিশ্বাসী guess না।
`
