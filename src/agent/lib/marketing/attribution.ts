/**
 * Phase 43 — profit-first attribution + reconciliation.
 *
 * Joins Meta spend, GA4 signals, the event ledger, and ERP order truth WITHOUT
 * pretending last-click is causal. Every number is labelled with its basis:
 *   observed  — read directly from a system of record
 *   modelled  — derived with stated assumptions (e.g. margin % fallback)
 *   unknown   — genuinely not knowable with current instrumentation
 *
 * Money: BDT whole taka everywhere (roundMoney).
 */
import { roundMoney } from '@/lib/money'
import { ledgerCounts } from '@/agent/lib/marketing/event-contract'
import { gatherMarketingReportData } from '@/agent/lib/marketing/report'

export type ValueBasis = 'observed' | 'modelled' | 'unknown'

export interface LabelledValue {
  value: number | null
  basis: ValueBasis
  /** Assumptions behind a modelled value; source for an observed one. */
  note: string
}

export const labelled = (value: number | null, basis: ValueBasis, note: string): LabelledValue => ({
  value: value === null ? null : roundMoney(value),
  basis,
  note,
})

export interface ProfitAttributionInput {
  spendBdt: number | null
  revenueDeliveredBdt: number | null
  revenueConfirmedBdt: number | null
  deliveredCount: number | null
  /** Gross margin as % of price when COGS-level truth is missing. */
  fallbackMarginPct: number | null
}

export interface ProfitAttribution {
  spend: LabelledValue
  deliveredRevenue: LabelledValue
  grossProfit: LabelledValue
  profitAfterSpend: LabelledValue
  costPerDelivered: LabelledValue
}

/** Profit math with explicit basis labels. Pure — fully testable. */
export function computeProfitAttribution(input: ProfitAttributionInput): ProfitAttribution {
  const spend =
    input.spendBdt === null
      ? labelled(null, 'unknown', 'Meta spend not readable')
      : labelled(input.spendBdt, 'observed', 'Meta insights spend')

  const deliveredRevenue =
    input.revenueDeliveredBdt !== null
      ? labelled(input.revenueDeliveredBdt, 'observed', 'ERP delivered-order revenue')
      : input.revenueConfirmedBdt !== null
        ? labelled(input.revenueConfirmedBdt, 'modelled', 'confirmed-order revenue used as proxy — delivered truth missing')
        : labelled(null, 'unknown', 'no revenue source readable')

  const grossProfit =
    deliveredRevenue.value === null
      ? labelled(null, 'unknown', 'no revenue → no profit calculation')
      : input.fallbackMarginPct === null
        ? labelled(null, 'unknown', 'no margin/COGS data — set margin in the growth brief')
        : labelled(
            (deliveredRevenue.value * input.fallbackMarginPct) / 100,
            'modelled',
            `assumes ${input.fallbackMarginPct}% gross margin (brief), revenue basis: ${deliveredRevenue.basis}`,
          )

  const profitAfterSpend =
    grossProfit.value === null || spend.value === null
      ? labelled(null, 'unknown', 'needs both gross profit and spend')
      : labelled(grossProfit.value - spend.value, 'modelled', 'gross profit (modelled) minus observed spend')

  const costPerDelivered =
    spend.value === null || !input.deliveredCount
      ? labelled(null, 'unknown', 'needs spend and delivered count')
      : labelled(spend.value / input.deliveredCount, 'modelled', 'blended — assumes all delivered orders were paid-driven, which overstates paid CAC')

  return { spend, deliveredRevenue, grossProfit, profitAfterSpend, costPerDelivered }
}

export interface ReconciliationInput {
  windowDays: number
  erp: { confirmed: number | null; delivered: number | null }
  ledger: Record<string, number>
  ga4KeyEvents: number | null
  metaPurchases: number | null
}

export interface ReconciliationIssue {
  kind: 'count_mismatch' | 'missing_pipeline' | 'stale_data'
  severity: 'high' | 'medium' | 'low'
  detail: string
}

export interface Reconciliation {
  issues: ReconciliationIssue[]
  /** 0–1 — how much these numbers can be trusted for optimization decisions. */
  confidence: number
  counts: { source: string; metric: string; value: number | null }[]
}

/**
 * Compare order/purchase counts across ERP, the event ledger, GA4, and Meta.
 * Sources legitimately differ (attribution windows, consent, adblock) — the
 * job is to flag DECISION-BREAKING divergence, not force equality.
 */
export function reconcileCounts(input: ReconciliationInput): Reconciliation {
  const issues: ReconciliationIssue[] = []
  const erpConfirmed = input.erp.confirmed
  const ledgerConfirmed = input.ledger.order_confirmed ?? 0

  const counts: Reconciliation['counts'] = [
    { source: 'erp', metric: 'confirmed', value: erpConfirmed },
    { source: 'erp', metric: 'delivered', value: input.erp.delivered },
    { source: 'ledger', metric: 'order_confirmed', value: ledgerConfirmed },
    { source: 'ga4', metric: 'keyEvents', value: input.ga4KeyEvents },
    { source: 'meta', metric: 'purchases', value: input.metaPurchases },
  ]

  if (erpConfirmed !== null && erpConfirmed > 0 && ledgerConfirmed === 0) {
    issues.push({
      kind: 'missing_pipeline',
      severity: 'high',
      detail: `ERP shows ${erpConfirmed} confirmed orders but the event ledger has none — order events are not being emitted yet.`,
    })
  } else if (erpConfirmed !== null && erpConfirmed > 0) {
    const ratio = ledgerConfirmed / erpConfirmed
    if (ratio < 0.8) {
      issues.push({
        kind: 'count_mismatch',
        severity: 'medium',
        detail: `Ledger captured ${ledgerConfirmed}/${erpConfirmed} confirmed orders (${Math.round(ratio * 100)}%) — missing events.`,
      })
    } else if (ratio > 1.2) {
      issues.push({
        kind: 'count_mismatch',
        severity: 'high',
        detail: `Ledger has MORE confirmed-order events (${ledgerConfirmed}) than ERP orders (${erpConfirmed}) — duplicate emission suspected.`,
      })
    }
  }

  if (input.ga4KeyEvents === null) {
    issues.push({ kind: 'missing_pipeline', severity: 'medium', detail: 'GA4 key events unreadable — no independent conversion signal.' })
  }
  if (input.metaPurchases === null) {
    issues.push({ kind: 'missing_pipeline', severity: 'low', detail: 'Meta purchase counts unreadable — platform-side view missing (fine if no CAPI yet).' })
  }

  let confidence = 1
  for (const i of issues) confidence -= i.severity === 'high' ? 0.4 : i.severity === 'medium' ? 0.2 : 0.1
  confidence = Math.max(0, Math.round(confidence * 100) / 100)

  return { issues, confidence, counts }
}

export interface AttributionReport {
  windowDays: number
  generatedAt: string
  profit: ProfitAttribution
  reconciliation: Reconciliation
  caveat: string
}

/** Assemble the live attribution + reconciliation report (read-only). */
export async function buildAttributionReport(opts: {
  windowDays?: number
  fallbackMarginPct?: number | null
  ga4KeyEvents?: number | null
  metaPurchases?: number | null
}): Promise<AttributionReport> {
  const windowDays = Math.min(Math.max(opts.windowDays ?? 7, 1), 30)
  const [report, ledger] = await Promise.all([
    gatherMarketingReportData(windowDays).catch(() => null),
    ledgerCounts(windowDays).catch(() => ({}) as Record<string, number>),
  ])

  const delivered = report?.funnel.ordersWeek.deliveredCount ?? null
  const profit = computeProfitAttribution({
    spendBdt: report ? report.paid.totalSpendWeek : null,
    revenueDeliveredBdt: null, // ERP summary is order-level revenue; delivered-only revenue lands with the event pipeline
    revenueConfirmedBdt: report ? report.funnel.ordersWeek.totalRevenue : null,
    deliveredCount: delivered,
    fallbackMarginPct: opts.fallbackMarginPct ?? null,
  })

  const reconciliation = reconcileCounts({
    windowDays,
    erp: { confirmed: report?.funnel.ordersWeek.totalOrders ?? null, delivered },
    ledger,
    ga4KeyEvents: opts.ga4KeyEvents ?? null,
    metaPurchases: opts.metaPurchases ?? null,
  })

  return {
    windowDays,
    generatedAt: new Date().toISOString(),
    profit,
    reconciliation,
    caveat:
      'Attribution is directional: last-click/platform-reported numbers are not causal truth. Observed vs modelled vs unknown labels are part of every value — never quote a modelled number as a fact.',
  }
}
