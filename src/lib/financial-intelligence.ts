/**
 * CFO-lite financial analysis — revenue, expenses, ad spend, margins, flags.
 * Uses roundMoney everywhere; never fabricates margin when cost data is missing.
 */
import { prisma } from '@/lib/prisma'
import { getLifestyleOrders } from '@/lib/lifestyle/read'
import { serverGet } from '@/lib/server-api'
import { todayYmdDhaka, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { aggregateDashboardMetrics, filterOrdersByDateRange } from '@/lib/order-analytics'
import { analyzePricing } from '@/lib/pricing-insight'
import { learnFact } from '@/lib/knowledge-graph'
import { roundMoney } from '@/lib/money'
import { ACTIVE_FINANCE_FILTER } from '@/agent/lib/finance-shared'
import type { Order } from '@/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface ProductProfitRow {
  product: string
  revenue: number
  units: number
  marginPct: number | null
  flag: string | null
}

export interface ChannelProfitRow {
  channel: string
  revenue: number
  orders: number
  adSpendAllocated: number | null
  note: string | null
}

export interface FinancialHealth {
  period: string
  days: number
  revenue: number
  expenses: { total: number; byCategory: Record<string, number> }
  adSpend: number
  adRevenue?: number
  grossProfit: number | null
  netProfit: number | null
  marginPct: number | null
  trends: { revenueWoW?: number; expenseWoW?: number }
  flags: string[]
  costDataMissing: boolean
  costDataCoveragePct: number
  productBreakdown: ProductProfitRow[]
  channelBreakdown: ChannelProfitRow[]
  subscriptionNote: string | null
  notes: string[]
}

async function fetchGasOrders(): Promise<Order[]> {
  try {
    const raw = await getLifestyleOrders({ business_id: 'ALMA_LIFESTYLE', limit: '500' })
    return raw.orders ?? []
  } catch {
    return []
  }
}

function pctChange(current: number, prior: number): number | undefined {
  if (prior <= 0) return current > 0 ? 100 : undefined
  return Math.round(((current - prior) / prior) * 100)
}

function safeNum(v: unknown): number {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

async function fetchAdSpendPeriod(startYmd: string, endYmd: string): Promise<number> {
  const token = process.env.META_ADS_TOKEN
  const accountId = process.env.META_AD_ACCOUNT_ID
  if (!token || !accountId) return 0

  try {
    const campRes = await fetch(
      `https://graph.facebook.com/v21.0/${accountId}/campaigns?effective_status=["ACTIVE","PAUSED"]&fields=id&limit=15&access_token=${token}`,
    )
    if (!campRes.ok) return 0
    const campData = (await campRes.json()) as { data?: Array<{ id: string }> }

    let total = 0
    const range = encodeURIComponent(JSON.stringify({ since: startYmd, until: endYmd }))
    for (const c of campData.data ?? []) {
      const url = `https://graph.facebook.com/v21.0/${c.id}/insights?time_range=${range}&fields=spend&access_token=${token}`
      const res = await fetch(url)
      if (!res.ok) continue
      const data = (await res.json()) as { data?: Array<{ spend?: string }> }
      total += safeNum(data.data?.[0]?.spend)
    }
    return roundMoney(total)
  } catch {
    return 0
  }
}

async function sumExpenses(start: Date, end: Date, currency = 'BDT') {
  const rows = await db.agentFinanceExpense.findMany({
    where: {
      ...ACTIVE_FINANCE_FILTER,
      currency,
      occurredAt: { gte: start, lte: end },
    },
    select: { amount: true, category: true },
  }) as Array<{ amount: number; category: string | null }>

  const byCategory: Record<string, number> = {}
  let total = 0
  for (const r of rows) {
    const cat = r.category?.trim() || 'অন্যান্য'
    const amt = roundMoney(r.amount)
    byCategory[cat] = roundMoney((byCategory[cat] ?? 0) + amt)
    total = roundMoney(total + amt)
  }
  return { total, byCategory }
}

async function subscriptionNote(): Promise<string | null> {
  const subs = await db.agentSubscription.findMany({
    where: { active: true },
    select: { name: true, amount: true, currency: true, billingCycle: true, nextRenewalAt: true },
  }) as Array<{
    name: string
    amount: unknown
    currency: string
    billingCycle: string
    nextRenewalAt: Date
  }>

  if (!subs.length) return null

  const soon = subs.filter((s) => {
    const days = Math.floor((s.nextRenewalAt.getTime() - Date.now()) / 86_400_000)
    return days >= 0 && days <= 14
  })

  const monthlyUsd = subs.reduce((sum, s) => {
    const amt = safeNum(s.amount)
    return sum + (s.billingCycle === 'yearly' ? amt / 12 : amt)
  }, 0)

  const parts = [`${subs.length}টি active subscription (~$${roundMoney(monthlyUsd)}/মাস fixed cost)`]
  if (soon.length) {
    parts.push(`${soon.map((s) => s.name).join(', ')} শীঘ্রই renew`)
  }
  return parts.join(' — ')
}

function periodMetrics(orders: Order[]) {
  const m = aggregateDashboardMetrics(orders)
  const revenue = roundMoney(m.kpis.total_revenue)
  const cogs = roundMoney(m.kpis.total_cogs)
  const grossProfit = cogs > 0 ? roundMoney(revenue - cogs) : roundMoney(m.kpis.total_profit)
  const hasCogs = cogs > 0
  return { revenue, cogs, grossProfit, hasCogs, metrics: m }
}

function buildProductBreakdown(
  metrics: ReturnType<typeof aggregateDashboardMetrics>,
  pricing: Awaited<ReturnType<typeof analyzePricing>>,
): ProductProfitRow[] {
  const marginMap = new Map(pricing.thinMargin.map((t) => [t.product.toLowerCase(), t.marginPct]))
  const volumeMap = new Map(pricing.highVolumeLowProfit.map((t) => [t.product.toLowerCase(), t.marginPct]))

  return metrics.top_products.slice(0, 8).map((p) => {
    const key = p.product.toLowerCase()
    const marginPct = marginMap.get(key) ?? volumeMap.get(key) ?? null
    let flag: string | null = null
    if (marginPct != null && marginPct < 15) {
      flag = 'ভালো বিক্রি কিন্তু মার্জিন পাতলা'
    } else if (pricing.costDataMissing) {
      flag = 'cost data নেই — margin অনুমান করা যায় না'
    }
    return {
      product: p.product,
      revenue: roundMoney(p.revenue),
      units: p.orders,
      marginPct,
      flag,
    }
  })
}

function buildChannelBreakdown(
  metrics: ReturnType<typeof aggregateDashboardMetrics>,
  adSpend: number,
): ChannelProfitRow[] {
  const sources = Object.entries(metrics.by_source)
    .map(([channel, v]) => ({
      channel,
      revenue: roundMoney(v.revenue),
      orders: v.orders,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6)

  const totalRev = sources.reduce((s, c) => s + c.revenue, 0)
  return sources.map((c) => {
    const share = totalRev > 0 ? c.revenue / totalRev : 0
    const allocated = adSpend > 0 && share > 0 ? roundMoney(adSpend * share) : null
    const note =
      allocated != null && c.revenue > 0
        ? `আনুমানিক ad allocation ৳${allocated} (attribution নিশ্চিত নয়)`
        : null
    return { ...c, adSpendAllocated: allocated, note }
  })
}

function buildFlags(args: {
  revenue: number
  expensesTotal: number
  adSpend: number
  grossProfit: number | null
  netProfit: number | null
  marginPct: number | null
  revenueWoW?: number
  expenseWoW?: number
  costDataMissing: boolean
  pricingFlags: string[]
  subNote: string | null
}): string[] {
  const flags: string[] = [...args.pricingFlags]

  if (args.costDataMissing) {
    flags.push(
      'প্রোডাক্ট-level cost price অনুপস্থিত — সত্যিকারের profit হিসাব করা যায়নি; inventory তে buying price রেকর্ড করুন।',
    )
  }

  if (args.expenseWoW != null && args.expenseWoW >= 15) {
    flags.push(`খরচ গত সমপরিমাণ সময়ের চেয়ে ${args.expenseWoW}% বেশি — সাবস্ক্রিপশন/অপারেটিং খরচ চেক করুন।`)
  }

  if (args.revenueWoW != null && args.revenueWoW <= -20) {
    flags.push(`রেভিনিউ WoW ${args.revenueWoW}% — সেল ট্রেন্ড দেখুন।`)
  }

  if (args.adSpend > 0 && args.revenue > 0) {
    const adRatio = Math.round((args.adSpend / args.revenue) * 100)
    if (adRatio >= 25) {
      flags.push(
        `অ্যাড খরচ ৳${args.adSpend}, রেভিনিউ ৳${args.revenue} (${adRatio}% of revenue) — ROI রিভিউ করুন (attribution নিশ্চিত নয়)।`,
      )
    }
  } else if (args.adSpend > 500 && args.revenue === 0) {
    flags.push(`অ্যাড খরচ ৳${args.adSpend} কিন্তু এই পিরিয়ডে সেল ডেটা কম — ক্যাম্পেইন রিভিউ করুন।`)
  }

  if (args.marginPct != null && args.marginPct < 12 && args.marginPct >= 0) {
    flags.push(`নেট মার্জিন ${args.marginPct}% কম — খরচ বা দাম দেখুন।`)
  }

  if (args.subNote && /শীঘ্রই renew/i.test(args.subNote)) {
    flags.push(`সাবস্ক্রিপশন renewal শীঘ্রই: ${args.subNote}`)
  }

  return [...new Set(flags)].slice(0, 8)
}

export async function persistFinancialKnowledge(health: FinancialHealth): Promise<number> {
  let count = 0
  for (const p of health.productBreakdown.filter((r) => r.marginPct != null).slice(0, 3)) {
    await learnFact({
      entityType: 'product',
      entityId: p.product,
      entityName: p.product,
      attribute: 'margin_band',
      value: `রেভিনিউ ৳${p.revenue} — margin ~${p.marginPct}% (${p.flag ?? 'স্বাভাবিক'})`,
      source: 'financial_intel',
      confidenceDelta: 0.08,
    })
    count++
  }
  for (const c of health.channelBreakdown.slice(0, 2)) {
    if (c.revenue <= 0) continue
    await learnFact({
      entityType: 'channel',
      entityId: c.channel,
      entityName: c.channel,
      attribute: 'revenue_share',
      value: `৳${c.revenue} revenue, ${c.orders} orders${c.adSpendAllocated ? `, ~৳${c.adSpendAllocated} ad (approx)` : ''}`,
      source: 'financial_intel',
      confidenceDelta: 0.06,
    })
    count++
  }
  return count
}

export async function analyzeFinancials(opts: { days?: number } = {}): Promise<FinancialHealth> {
  const days = Math.min(Math.max(opts.days ?? 30, 7), 90)
  const endYmd = todayYmdDhaka()
  const startYmd = addDaysYmd(endYmd, -(days - 1))
  const priorEndYmd = addDaysYmd(startYmd, -1)
  const priorStartYmd = addDaysYmd(priorEndYmd, -(days - 1))

  const endDate = new Date(`${endYmd}T23:59:59Z`)
  const startDate = new Date(`${startYmd}T00:00:00Z`)
  const priorEndDate = new Date(`${priorEndYmd}T23:59:59Z`)
  const priorStartDate = new Date(`${priorStartYmd}T00:00:00Z`)

  const [allOrders, pricing, expenses, priorExpenses, adSpend, priorAdSpend, subNote] =
    await Promise.all([
      fetchGasOrders(),
      analyzePricing(),
      sumExpenses(startDate, endDate),
      sumExpenses(priorStartDate, priorEndDate),
      fetchAdSpendPeriod(startYmd, endYmd),
      fetchAdSpendPeriod(priorStartYmd, priorEndYmd),
      subscriptionNote(),
    ])

  const periodOrders = filterOrdersByDateRange(allOrders, { start: startYmd, end: endYmd })
  const priorOrders = filterOrdersByDateRange(allOrders, { start: priorStartYmd, end: priorEndYmd })

  const cur = periodMetrics(periodOrders)
  const prev = periodMetrics(priorOrders)

  const revenue = cur.revenue
  const operatingCosts = roundMoney(expenses.total + adSpend)
  const costDataMissing = pricing.costDataMissing || (revenue > 0 && cur.cogs <= 0)

  let grossProfit: number | null = null
  let netProfit: number | null = null
  let marginPct: number | null = null

  if (!costDataMissing && cur.cogs > 0) {
    grossProfit = roundMoney(cur.grossProfit)
    netProfit = roundMoney(grossProfit - operatingCosts)
    marginPct = revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : null
  } else {
    grossProfit = null
    netProfit = roundMoney(revenue - operatingCosts)
    marginPct = revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : null
  }

  const revenueWoW = pctChange(revenue, prev.revenue)
  const expenseWoW = pctChange(
    roundMoney(expenses.total + adSpend),
    roundMoney(priorExpenses.total + priorAdSpend),
  )

  const notes: string[] = []
  if (costDataMissing) {
    notes.push('COGS/cost price অনুপস্থিত — gross profit দেখানো হয়নি; revenue minus known operating costs only.')
  }
  if (adSpend > 0) {
    notes.push('Ad ROI = correlation only; revenue attribution to ads is not fully reliable.')
  }

  const flags = buildFlags({
    revenue,
    expensesTotal: expenses.total,
    adSpend,
    grossProfit,
    netProfit,
    marginPct,
    revenueWoW,
    expenseWoW,
    costDataMissing,
    pricingFlags: pricing.flags,
    subNote,
  })

  const health: FinancialHealth = {
    period: `${startYmd} → ${endYmd}`,
    days,
    revenue,
    expenses: { total: expenses.total, byCategory: expenses.byCategory },
    adSpend,
    adRevenue: undefined,
    grossProfit,
    netProfit,
    marginPct,
    trends: { revenueWoW, expenseWoW },
    flags,
    costDataMissing,
    costDataCoveragePct: pricing.costDataCoveragePct,
    productBreakdown: buildProductBreakdown(cur.metrics, pricing),
    channelBreakdown: buildChannelBreakdown(cur.metrics, adSpend),
    subscriptionNote: subNote,
    notes,
  }

  return health
}

/** Nightly knowledge build — analyze + persist margin/ROI facts. */
export async function analyzeAndPersistFinancials(days = 30): Promise<FinancialHealth> {
  const health = await analyzeFinancials({ days })
  await persistFinancialKnowledge(health)
  return health
}

export function formatFinancialBrief(health: FinancialHealth): string {
  const L: string[] = []
  L.push(`💰 *আর্থিক স্বাস্থ্য (গত ${health.days} দিন)*`)
  L.push(`আয়: ৳${health.revenue} | খরচ: ৳${health.expenses.total} | অ্যাড: ৳${health.adSpend}`)

  if (health.grossProfit != null) {
    L.push(`গ্রস: ৳${health.grossProfit} | নেট: ৳${health.netProfit ?? '—'} (মার্জিন ${health.marginPct ?? '—'}%)`)
  } else {
    L.push(`নেট (known costs only): ৳${health.netProfit ?? '—'} — *সত্যিকারের margin হিসাবের জন্য cost price দিন*`)
  }

  if (health.trends.revenueWoW != null) {
    L.push(`ট্রেন্ড: রেভিনিউ WoW ${health.trends.revenueWoW > 0 ? '+' : ''}${health.trends.revenueWoW}%`)
  }
  if (health.trends.expenseWoW != null) {
    L.push(`খরচ WoW ${health.trends.expenseWoW > 0 ? '+' : ''}${health.trends.expenseWoW}%`)
  }

  if (health.flags.length) {
    L.push('')
    L.push('⚠️ *ফ্ল্যাগ:*')
    health.flags.slice(0, 4).forEach((f) => L.push(`• ${f}`))
  }

  if (health.subscriptionNote) {
    L.push(`\n🔄 ${health.subscriptionNote}`)
  }

  return L.join('\n')
}
