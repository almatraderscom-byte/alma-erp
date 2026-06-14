/**
 * Wire trackOutcome into suggestion generation points.
 */
import { trackOutcome } from '@/lib/outcome-loop'
import { getProductUnitsSold } from '@/lib/outcome-metrics'
import type { BriefingDecision } from '@/agent/lib/owner-briefing-data'
import type { ReorderSuggestion } from '@/lib/inventory-forecast'

export async function trackReorderOutcomes(suggestions: ReorderSuggestion[]) {
  for (const r of suggestions.slice(0, 3)) {
    const sales7d = await getProductUnitsSold(r.id, 7).catch(() => null)
    await trackOutcome({
      type: 'reorder',
      subjectKind: 'product',
      subjectId: r.id,
      subjectName: r.name,
      suggestion: `~${r.suggestedQty}টি রিঅর্ডার করুন — ${r.reason}`,
      rationale: r.reason,
      metric: 'units_sold_7d',
      baselineValue: sales7d ?? undefined,
      predicted: 'স্টকআউট ছাড়াই বিক্রি চলবে',
      measureAfterDays: 7,
    })
  }
}

export async function trackBriefingDecisionOutcomes(
  decisions: BriefingDecision[],
  sales: { yesterdayTotal: number; sevenDayAvg: number } | null,
) {
  for (const d of decisions) {
    if (d.area === 'sales' && /ad boost/i.test(d.recommend)) {
      await trackOutcome({
        type: 'ad_boost',
        subjectKind: 'campaign',
        subjectName: 'bestseller_ad_boost',
        suggestion: d.recommend,
        rationale: d.text,
        metric: 'sales_total_7d',
        baselineValue: sales?.sevenDayAvg ? sales.sevenDayAvg * 7 : sales?.yesterdayTotal,
        predicted: '৭ দিনের সেল গড়ের দিকে উন্নতি',
        measureAfterDays: 7,
      })
    }
    if (d.area === 'pricing') {
      await trackOutcome({
        type: 'pricing',
        subjectKind: 'product',
        subjectName: d.text.slice(0, 80),
        suggestion: d.recommend,
        rationale: d.text,
        metric: 'units_sold_14d',
        predicted: 'ভলিউম/মার্জিন রিভিউ পর পরিবর্তন',
        measureAfterDays: 14,
      })
    }
  }
}

export async function trackWinbackCohort(
  customers: Array<{ id: string; name?: string | null }>,
) {
  if (!customers.length) return
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const ids = customers.slice(0, 20).map((c) => c.id)
  await trackOutcome({
    type: 'winback',
    subjectKind: 'customer',
    subjectId: `cohort-${today}`,
    subjectName: `Win-back cohort (${ids.length})`,
    suggestion: 'এদের জন্য অফার পোস্ট boost করুন বা মেসেজ করুন',
    rationale: JSON.stringify({ customerIds: ids }),
    metric: 'winback_return_14d',
    baselineValue: ids.length,
    predicted: 'কিছু কাস্টমার ১৪ দিনে ফিরে আসবে',
    measureAfterDays: 14,
  })
}

export async function trackContentTaskOutcomes(
  tasks: Array<{ type: string; productRef?: string; title: string }>,
) {
  const contentTypes = new Set(['product_content', 'ad_creative', 'video_reel'])
  const seen = new Set<string>()

  for (const t of tasks) {
    if (!contentTypes.has(t.type) || !t.productRef || seen.has(t.productRef)) continue
    seen.add(t.productRef)

    const sales14d = await getProductUnitsSold(t.productRef, 14).catch(() => null)
    await trackOutcome({
      type: 'content',
      subjectKind: 'product',
      subjectId: t.productRef,
      subjectName: t.productRef,
      suggestion: t.title,
      rationale: `Staff content task: ${t.type}`,
      metric: 'units_sold_14d',
      baselineValue: sales14d ?? undefined,
      predicted: 'কন্টেন্টের পর ১৪ দিনে বিক্রি বাড়তে পারে',
      measureAfterDays: 14,
    })
  }
}
