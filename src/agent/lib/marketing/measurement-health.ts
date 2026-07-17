/**
 * Phase 41 — measurement health: is the marketing data decision-grade?
 *
 * Joins what we can observe (ERP orders funnel, GA4 probe, Meta spend
 * coverage) and flags the gaps that make optimization decisions unsafe:
 * thin samples, funnel breaks, missing analytics, revenue mismatch risk.
 * Everything unobservable is labelled unknown — never invented.
 *
 * Money is BDT whole-taka (roundMoney) in every business calculation.
 */
import { roundMoney } from '@/lib/money'
import { runGa4Report, isGa4Configured } from '@/agent/lib/ga4'
import { gatherMarketingReportData } from '@/agent/lib/marketing/report'

export interface DataGap {
  kind:
    | 'thin_sample'
    | 'funnel_break'
    | 'missing_analytics'
    | 'missing_spend'
    | 'revenue_mismatch_risk'
    | 'attribution_uncertain'
  severity: 'high' | 'medium' | 'low'
  detail: string
}

export interface MeasurementHealth {
  generatedAt: string
  windowDays: number
  erp: {
    observed: boolean
    orders: number
    delivered: number | null
    revenueBdt: number
  }
  analytics: {
    ga4Configured: boolean
    observed: boolean
    sessions: number | null
    keyEvents: number | null
  }
  paid: {
    observed: boolean
    /** Spend in the AD ACCOUNT'S currency (see `currency`) — field name is legacy; NOT necessarily ৳. */
    spendBdt: number
    currency: string
    /** The ad account actually read — a wrong META_AD_ACCOUNT_ID shows here instead of hiding as 0. */
    accountId: string | null
    campaignsWithData: number
  }
  gaps: DataGap[]
  /** True when core decisions should not be made from this data alone. */
  thinData: boolean
}

/** A funnel stage with volume this low over the window cannot support optimization decisions. */
export function detectThinSample(count: number, windowDays: number, label: string): DataGap | null {
  // Rule of thumb: fewer than 1 observation per 2 days is decision-thin.
  const threshold = Math.max(3, Math.floor(windowDays / 2))
  if (count >= threshold) return null
  return {
    kind: 'thin_sample',
    severity: count === 0 ? 'high' : 'medium',
    detail: `${label}: ${count} in ${windowDays} days (need ≥${threshold} for a directional read)`,
  }
}

/** Orders exist but none delivered over a long-enough window ⇒ the COD funnel reporting is broken somewhere. */
export function detectFunnelBreak(orders: number, delivered: number | null, windowDays: number): DataGap | null {
  if (orders <= 0) return null
  if (delivered === null) {
    return {
      kind: 'funnel_break',
      severity: 'medium',
      detail: `Delivered count is unavailable while ${orders} orders exist — delivered-COD truth is missing from the funnel.`,
    }
  }
  if (delivered === 0 && windowDays >= 7 && orders >= 5) {
    return {
      kind: 'funnel_break',
      severity: 'high',
      detail: `${orders} orders but 0 delivered in ${windowDays} days — either delivery lag or a broken status pipeline. Verify before optimizing on "orders".`,
    }
  }
  return null
}

/** Spend without analytics (or vice versa) makes attribution guesswork. */
export function detectAttributionGaps(input: {
  spendBdt: number
  ga4Observed: boolean
  orders: number
}): DataGap[] {
  const gaps: DataGap[] = []
  if (input.spendBdt > 0 && !input.ga4Observed) {
    gaps.push({
      kind: 'missing_analytics',
      severity: 'high',
      detail: 'Ad spend is flowing but GA4 is not readable — no independent traffic/conversion signal to check Meta claims against.',
    })
  }
  if (input.spendBdt > 0 && input.orders > 0) {
    gaps.push({
      kind: 'attribution_uncertain',
      severity: 'low',
      detail: 'Spend and orders both observed, but no event-level join exists yet (Pixel/CAPI + UTM lineage is Phase 43). Treat channel attribution as directional.',
    })
  }
  if (input.spendBdt === 0 && input.orders > 0) {
    gaps.push({
      kind: 'missing_spend',
      severity: 'medium',
      detail: 'Orders observed with zero readable ad spend — either genuinely organic or Meta insights are not readable. Confirm before crediting organic.',
    })
  }
  return gaps
}

/** Assemble the full measurement-health picture. Read-only; degrades gracefully. */
export async function assessMeasurementHealth(windowDays = 7): Promise<MeasurementHealth> {
  const days = Math.min(Math.max(windowDays, 1), 30)

  const [report, ga4Configured] = await Promise.all([
    gatherMarketingReportData(days).catch(() => null),
    isGa4Configured().catch(() => false),
  ])

  let sessions: number | null = null
  let keyEvents: number | null = null
  let ga4Observed = false
  if (ga4Configured) {
    const probe = await runGa4Report({
      startDate: `${days}daysAgo`,
      endDate: 'today',
      dimensions: ['date'],
      metrics: ['sessions', 'keyEvents'],
      limit: 31,
    }).catch(() => null)
    if (probe && probe.ok) {
      ga4Observed = true
      sessions = probe.rows.reduce((s, r) => s + (r.metrics[0] ?? 0), 0)
      keyEvents = probe.rows.reduce((s, r) => s + (r.metrics[1] ?? 0), 0)
    }
  }

  const orders = report?.funnel.ordersWeek.totalOrders ?? 0
  const delivered = report?.funnel.ordersWeek.deliveredCount ?? null
  const revenueBdt = roundMoney(report?.funnel.ordersWeek.totalRevenue ?? 0)
  const spendBdt = roundMoney(report?.paid.totalSpendWeek ?? 0)
  const campaignsWithData = report?.paid.campaigns.filter((c) => c.hasData).length ?? 0

  const gaps: DataGap[] = []
  const thinOrders = detectThinSample(orders, days, 'ERP orders')
  if (thinOrders) gaps.push(thinOrders)
  const funnelBreak = detectFunnelBreak(orders, delivered, days)
  if (funnelBreak) gaps.push(funnelBreak)
  gaps.push(...detectAttributionGaps({ spendBdt, ga4Observed, orders }))
  if (!ga4Configured) {
    gaps.push({
      kind: 'missing_analytics',
      severity: 'medium',
      detail: 'GA4 is not configured/connected — website behaviour is invisible to marketing decisions.',
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    erp: { observed: report !== null, orders, delivered, revenueBdt },
    analytics: { ga4Configured, observed: ga4Observed, sessions, keyEvents },
    paid: {
      observed: report !== null && report.paid.campaigns.length > 0,
      spendBdt,
      currency: report?.paid.currency ?? 'USD',
      accountId: report?.paid.accountId ?? null,
      campaignsWithData,
    },
    gaps,
    thinData: Boolean(thinOrders) || campaignsWithData === 0,
  }
}
