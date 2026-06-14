/**
 * Weekly strategic review — deterministic data gathering (numbers only; LLM narrates).
 */
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { serverGet } from '@/lib/server-api'
import { todayYmdDhaka, daysAgoYmd, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import {
  aggregateDashboardMetrics,
  filterOrdersByDateRange,
  normalizeOrderStatusKey,
} from '@/lib/order-analytics'
import { analyzeReturns } from '@/lib/return-analysis'
import { segmentCustomers } from '@/lib/customer-intelligence'
import { roundMoney } from '@/lib/money'
import { AGENT_MODEL, isAnthropicConfigured } from '@/agent/config'
import { calcAnthropicChatCostUsd } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'
import type { Order } from '@/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type WeeklyStrategicData = {
  period: { thisWeekStart: string; thisWeekEnd: string; priorWeekStart: string; priorWeekEnd: string }
  business: {
    thisWeekRevenue: number
    priorWeekRevenue: number
    wowRevenuePct: number | null
    thisWeekOrders: number
    priorWeekOrders: number
    wowOrdersPct: number | null
    thisWeekReturnRatePct: number | null
    priorWeekReturnRatePct: number | null
    newCustomers: number
    repeatCustomers: number
    adsWeekSpend: number | null
    adsWeekCtrAvg: number | null
    topProducts: Array<{ name: string; thisWeekRevenue: number; priorRevenue: number; changePct: number | null }>
    categoryShifts: Array<{ category: string; thisWeekRevenue: number; priorRevenue: number; changePct: number | null }>
    dailyOrdersThisWeek: number[]
    dailyOrdersPriorWeek: number[]
  }
  movers: {
    growing: Array<{ name: string; changePct: number | null; driver: string }>
    stalling: Array<{ name: string; detail: string; driver: string }>
  }
  selfReview: {
    suggestionsMade: number
    approved: number
    rejected: number
    stillPending: number
    acceptanceRatePct: number | null
    outcomes: {
      worked: number
      noEffect: number
      worse: number
      inconclusive: number
      stillMeasuring: number
    }
    misses: Array<{ suggestion: string; subjectName: string | null; result: string; learning: string }>
    wins: Array<{ suggestion: string; subjectName: string | null; learning: string }>
  }
  focusCandidates: Array<{ action: string; reason: string }>
}

async function fetchGasOrders(): Promise<Order[]> {
  try {
    const raw = await serverGet<{ orders?: Order[] }>(
      'orders',
      { business_id: 'ALMA_LIFESTYLE', limit: '500' },
      0,
    )
    return raw.orders ?? []
  } catch {
    return []
  }
}

function pctChange(current: number, prior: number): number | null {
  if (prior <= 0) return current > 0 ? 100 : null
  return Math.round(((current - prior) / prior) * 100)
}

function returnRateForOrders(orders: Order[]): number | null {
  if (!orders.length) return null
  const returned = orders.filter((o) => {
    const s = normalizeOrderStatusKey(String(o.status))
    return s === 'RETURNED' || s === 'RETURNED_PAID' || s === 'RETURNED_UNPAID'
  }).length
  return Math.round((returned / orders.length) * 1000) / 10
}

function customerPhone(order: Order): string | null {
  const p = String(order.phone ?? '').replace(/\D/g, '')
  return p.length >= 10 ? p : null
}

async function countNewVsRepeat(orders: Order[]): Promise<{ newCustomers: number; repeatCustomers: number }> {
  const phones = [...new Set(orders.map(customerPhone).filter(Boolean))] as string[]
  if (!phones.length) return { newCustomers: 0, repeatCustomers: 0 }

  const rows = await prisma.csCustomer.findMany({
    where: { phone: { in: phones } },
    select: { phone: true, ordersCount: true },
  })
  const byPhone = new Map(rows.map((r) => [r.phone?.replace(/\D/g, '') ?? '', r.ordersCount]))

  let newCustomers = 0
  let repeatCustomers = 0
  for (const phone of phones) {
    const count = byPhone.get(phone)
    if (!count || count <= 1) newCustomers++
    else repeatCustomers++
  }
  return { newCustomers, repeatCustomers }
}

function safeNum(v: unknown): number {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

async function gatherAdsWeekMetrics(): Promise<{ spend: number | null; ctrAvg: number | null }> {
  const token = process.env.META_ADS_TOKEN
  const accountId = process.env.META_AD_ACCOUNT_ID
  if (!token || !accountId) return { spend: null, ctrAvg: null }

  try {
    const today = todayYmdDhaka()
    const weekStart = daysAgoYmd(6)
    const campRes = await fetch(
      `https://graph.facebook.com/v21.0/${accountId}/campaigns?effective_status=["ACTIVE"]&fields=id,name&limit=10&access_token=${token}`,
    )
    if (!campRes.ok) return { spend: null, ctrAvg: null }
    const campData = (await campRes.json()) as { data?: Array<{ id: string }> }

    let totalSpend = 0
    let ctrSum = 0
    let ctrCount = 0

    for (const c of campData.data ?? []) {
      const url = `https://graph.facebook.com/v21.0/${c.id}/insights?time_range=${encodeURIComponent(JSON.stringify({ since: weekStart, until: today }))}&fields=spend,ctr&access_token=${token}`
      const res = await fetch(url)
      if (!res.ok) continue
      const data = (await res.json()) as { data?: Array<{ spend?: string; ctr?: string }> }
      const row = data.data?.[0]
      if (!row) continue
      totalSpend += safeNum(row.spend)
      const ctr = safeNum(row.ctr)
      if (ctr > 0) {
        ctrSum += ctr
        ctrCount++
      }
    }

    return {
      spend: totalSpend > 0 ? Math.round(totalSpend) : null,
      ctrAvg: ctrCount > 0 ? Math.round((ctrSum / ctrCount) * 10000) / 100 : null,
    }
  } catch {
    return { spend: null, ctrAvg: null }
  }
}

function compareProducts(
  thisOrders: Order[],
  priorOrders: Order[],
): WeeklyStrategicData['business']['topProducts'] {
  const thisM = aggregateDashboardMetrics(thisOrders)
  const priorM = aggregateDashboardMetrics(priorOrders)
  const priorMap = new Map(priorM.top_products.map((p) => [p.product, p.revenue]))

  const deltas = thisM.top_products.map((p) => {
    const priorRev = priorMap.get(p.product) ?? 0
    return {
      name: p.product,
      thisWeekRevenue: roundMoney(p.revenue),
      priorRevenue: roundMoney(priorRev),
      changePct: pctChange(p.revenue, priorRev),
    }
  })

  return deltas
    .sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999))
    .slice(0, 8)
}

function compareCategories(
  thisOrders: Order[],
  priorOrders: Order[],
): WeeklyStrategicData['business']['categoryShifts'] {
  const thisM = aggregateDashboardMetrics(thisOrders)
  const priorM = aggregateDashboardMetrics(priorOrders)

  const allCats = new Set([
    ...Object.keys(thisM.by_category),
    ...Object.keys(priorM.by_category),
  ])

  return [...allCats]
    .map((category) => {
      const tw = thisM.by_category[category]?.revenue ?? 0
      const pw = priorM.by_category[category]?.revenue ?? 0
      return {
        category,
        thisWeekRevenue: roundMoney(tw),
        priorRevenue: roundMoney(pw),
        changePct: pctChange(tw, pw),
      }
    })
    .filter((c) => c.thisWeekRevenue > 0 || c.priorRevenue > 0)
    .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))
    .slice(0, 6)
}

function dailyOrderCounts(orders: Order[], startYmd: string, days: number): number[] {
  const counts: number[] = []
  for (let i = 0; i < days; i++) {
    const ymd = addDaysYmd(startYmd, i)
    const dayOrders = filterOrdersByDateRange(orders, { start: ymd, end: ymd })
    counts.push(dayOrders.length)
  }
  return counts
}

async function gatherSelfReview(since: Date): Promise<WeeklyStrategicData['selfReview']> {
  const [actions, outcomesCreated, outcomesMeasured] = await Promise.all([
    db.agentPendingAction.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, summary: true },
    }),
    db.agentOutcome.findMany({
      where: { createdAt: { gte: since } },
      select: { id: true },
    }),
    db.agentOutcome.findMany({
      where: {
        OR: [
          { createdAt: { gte: since } },
          { measuredAt: { gte: since } },
        ],
      },
      select: {
        suggestion: true,
        subjectName: true,
        result: true,
        learning: true,
        status: true,
      },
    }),
  ])

  const approved = actions.filter((a: { status: string }) =>
    ['approved', 'executed', 'approved_queued'].includes(a.status),
  ).length
  const rejected = actions.filter((a: { status: string }) => a.status === 'rejected').length
  const stillPending = actions.filter((a: { status: string }) => a.status === 'pending').length
  const resolved = approved + rejected
  const acceptanceRatePct = resolved > 0 ? Math.round((approved / resolved) * 100) : null

  const suggestionsMade = Math.max(actions.length, outcomesCreated.length)

  const outcomes = { worked: 0, noEffect: 0, worse: 0, inconclusive: 0, stillMeasuring: 0 }
  const misses: WeeklyStrategicData['selfReview']['misses'] = []
  const wins: WeeklyStrategicData['selfReview']['wins'] = []

  for (const o of outcomesMeasured as Array<{
    suggestion: string
    subjectName: string | null
    result: string | null
    learning: string | null
    status: string
  }>) {
    if (o.status === 'pending') {
      outcomes.stillMeasuring++
      continue
    }
    if (o.result === 'worked') {
      outcomes.worked++
      if (o.learning && wins.length < 3) {
        wins.push({ suggestion: o.suggestion, subjectName: o.subjectName, learning: o.learning })
      }
    } else if (o.result === 'no_effect') {
      outcomes.noEffect++
      if (misses.length < 4) {
        misses.push({
          suggestion: o.suggestion,
          subjectName: o.subjectName,
          result: 'no_effect',
          learning: o.learning ?? 'মেট্রিক প্রায় একই ছিল।',
        })
      }
    } else if (o.result === 'worse') {
      outcomes.worse++
      if (misses.length < 4) {
        misses.push({
          suggestion: o.suggestion,
          subjectName: o.subjectName,
          result: 'worse',
          learning: o.learning ?? 'মেট্রিক কমেছে।',
        })
      }
    } else {
      outcomes.inconclusive++
    }
  }

  return {
    suggestionsMade,
    approved,
    rejected,
    stillPending,
    acceptanceRatePct,
    outcomes,
    misses,
    wins,
  }
}

async function gatherStallingProducts(): Promise<WeeklyStrategicData['movers']['stalling']> {
  try {
    const cutoff = new Date(Date.now() - 21 * 86_400_000).toISOString()
    const rows = await db.agentProductMarketingHistory.findMany({
      where: { lastPromotedAt: { lt: new Date(cutoff) } },
      orderBy: { lastPromotedAt: 'asc' },
      take: 5,
      select: { productRef: true, lastPromotedAt: true },
    })
    return rows.map((r: { productRef: string; lastPromotedAt: Date }) => {
      const days = Math.floor((Date.now() - r.lastPromotedAt.getTime()) / 86_400_000)
      const weeks = Math.round(days / 7)
      return {
        name: r.productRef,
        detail: `${weeks} সপ্তাহ মার্কেটিং নেই`,
        driver: 'কন্টেন্ট/প্রোমো গ্যাপ — বিক্রি স্থির হতে পারে',
      }
    })
  } catch {
    return []
  }
}

export async function gatherWeeklyStrategicData(): Promise<WeeklyStrategicData> {
  const thisWeekEnd = todayYmdDhaka()
  const thisWeekStart = daysAgoYmd(6)
  const priorWeekEnd = daysAgoYmd(7)
  const priorWeekStart = daysAgoYmd(13)

  const allOrders = await fetchGasOrders()
  const thisOrders = filterOrdersByDateRange(allOrders, { start: thisWeekStart, end: thisWeekEnd })
  const priorOrders = filterOrdersByDateRange(allOrders, { start: priorWeekStart, end: priorWeekEnd })

  const thisM = aggregateDashboardMetrics(thisOrders)
  const priorM = aggregateDashboardMetrics(priorOrders)

  const thisWeekRevenue = roundMoney(thisM.kpis.total_revenue)
  const priorWeekRevenue = roundMoney(priorM.kpis.total_revenue)

  const [{ newCustomers, repeatCustomers }, ads, returns7d, segments, stalling, selfReview] =
    await Promise.all([
      countNewVsRepeat(thisOrders),
      gatherAdsWeekMetrics(),
      analyzeReturns({ days: 7 }),
      segmentCustomers(),
      gatherStallingProducts(),
      gatherSelfReview(new Date(Date.now() - 7 * 86_400_000)),
    ])

  const priorReturns = await analyzeReturns({ days: 14 })
  const priorReturnRate =
    priorReturns.returnRatePct != null && returns7d.returnRatePct != null
      ? Math.round((priorReturns.returnRatePct * 2 - returns7d.returnRatePct) * 10) / 10
      : null

  const topProducts = compareProducts(thisOrders, priorOrders)
  const categoryShifts = compareCategories(thisOrders, priorOrders)

  const growing = topProducts
    .filter((p) => (p.changePct ?? 0) >= 10 && p.thisWeekRevenue > 0)
    .slice(0, 3)
    .map((p) => ({
      name: p.name,
      changePct: p.changePct,
      driver: p.changePct != null && p.changePct >= 20
        ? 'বিক্রি তীব্র বৃদ্ধি — কন্টেন্ট/ডিমান্ড ম্যাচ হতে পারে'
        : 'ধীরে বাড়ছে — ট্রেন্ড পজিটিভ',
    }))

  const stallingFromSales = topProducts
    .filter((p) => p.priorRevenue > 500 && (p.changePct ?? 0) <= -15)
    .slice(0, 2)
    .map((p) => ({
      name: p.name,
      detail: `বিক্রি ${p.changePct}% কমেছে`,
      driver: 'ডিমান্ড কমা বা প্রোমো গ্যাপ',
    }))

  const moversStalling = [...stalling, ...stallingFromSales].slice(0, 3)

  const focusCandidates: WeeklyStrategicData['focusCandidates'] = []

  if (stalling[0]) {
    focusCandidates.push({
      action: `${stalling[0].name}-এ কন্টেন্ট/মার্কেটিং`,
      reason: stalling[0].detail,
    })
  }
  if (growing[0]) {
    focusCandidates.push({
      action: `${growing[0].name} স্টক বাড়ান`,
      reason: `গত সপ্তাহে বিক্রি বেড়েছে (${growing[0].changePct ?? '—'}%)`,
    })
  }
  if (segments.winBack.length) {
    const n = Math.min(segments.winBack.length, 20)
    focusCandidates.push({
      action: `${n} জন quiet customer-কে win-back অফার`,
      reason: '৪৫–১৮০ দিন অর্ডার নেই, ২+ অর্ডার ইতিহাস',
    })
  }
  if (returns7d.returnRatePct != null && returns7d.returnRatePct > 12) {
    focusCandidates.push({
      action: 'রিটার্ন কারণ রিভিউ (সাইজিং/কোয়ালিটি)',
      reason: `রিটার্ন রেট ${returns7d.returnRatePct}% — স্বাভাবিকের উপরে`,
    })
  }

  return {
    period: {
      thisWeekStart,
      thisWeekEnd,
      priorWeekStart,
      priorWeekEnd,
    },
    business: {
      thisWeekRevenue,
      priorWeekRevenue,
      wowRevenuePct: pctChange(thisWeekRevenue, priorWeekRevenue),
      thisWeekOrders: thisM.kpis.total_orders,
      priorWeekOrders: priorM.kpis.total_orders,
      wowOrdersPct: pctChange(thisM.kpis.total_orders, priorM.kpis.total_orders),
      thisWeekReturnRatePct: returns7d.returnRatePct,
      priorWeekReturnRatePct: priorReturnRate,
      newCustomers,
      repeatCustomers,
      adsWeekSpend: ads.spend,
      adsWeekCtrAvg: ads.ctrAvg,
      topProducts,
      categoryShifts,
      dailyOrdersThisWeek: dailyOrderCounts(allOrders, thisWeekStart, 7),
      dailyOrdersPriorWeek: dailyOrderCounts(allOrders, priorWeekStart, 7),
    },
    movers: { growing, stalling: moversStalling },
    selfReview,
    focusCandidates: focusCandidates.slice(0, 4),
  }
}

function fallbackMessage(data: WeeklyStrategicData): string {
  const b = data.business
  const wow = b.wowRevenuePct != null ? `${b.wowRevenuePct > 0 ? '+' : ''}${b.wowRevenuePct}%` : '—'
  const sr = data.selfReview
  const lines = [
    '📊 *সাপ্তাহিক স্ট্র্যাটেজিক রিভিউ*',
    '',
    `*বিজনেস:* সেল গত সপ্তাহের তুলনায় ${wow} (৳${b.thisWeekRevenue} vs ৳${b.priorWeekRevenue})। অর্ডার: ${b.thisWeekOrders}। রিটার্ন: ${b.thisWeekReturnRatePct ?? '—'}%। নতুন/রিপিট: ${b.newCustomers}/${b.repeatCustomers}।`,
  ]
  if (b.adsWeekSpend != null) {
    lines.push(`Ad spend (৭ দিন): ৳${b.adsWeekSpend}${b.adsWeekCtrAvg != null ? `, CTR ~${b.adsWeekCtrAvg}%` : ''}।`)
  }
  if (data.movers.growing.length) {
    lines.push(`\n*বাড়ছে:* ${data.movers.growing.map((g) => `${g.name} (${g.changePct ?? '—'}%)`).join(', ')}`)
  }
  if (data.movers.stalling.length) {
    lines.push(`*আটকে:* ${data.movers.stalling.map((s) => `${s.name}: ${s.detail}`).join('; ')}`)
  }
  lines.push(
    '',
    '🤖 *আমার নিজের রিভিউ:*',
    `• এই সপ্তাহে ${sr.suggestionsMade}টি পরামর্শ — approve ${sr.approved}, reject ${sr.rejected}${sr.stillPending ? `, pending ${sr.stillPending}` : ''}।`,
    `• ফলাফল: ${sr.outcomes.worked} worked, ${sr.outcomes.noEffect} no-effect, ${sr.outcomes.worse} worse, ${sr.outcomes.stillMeasuring} measuring।`,
  )
  for (const m of sr.misses.slice(0, 2)) {
    lines.push(`• ভুল: "${m.suggestion.slice(0, 60)}" — ${m.learning}`)
  }
  if (data.focusCandidates.length) {
    lines.push('', '🎯 *আগামী সপ্তাহের ফোকাস:*')
    data.focusCandidates.forEach((f, i) => lines.push(`${i + 1}. ${f.action} — ${f.reason}`))
  }
  return lines.join('\n')
}

export async function narrateWeeklyStrategic(data: WeeklyStrategicData): Promise<string> {
  if (!isAnthropicConfigured()) return fallbackMessage(data)

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  const factsJson = JSON.stringify(data, null, 0).slice(0, 14000)

  const res = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 700,
    messages: [{
      role: 'user',
      content:
        'আপনি ALMA Lifestyle-এর সিনিয়র বিজনেস অ্যানালিস্ট। নিচের REAL ডেটা থেকে সাপ্তাহিক স্ট্র্যাটেজিক রিভিউ লিখুন — শুধু বাংলায়, Telegram markdown (*bold*).\n\n' +
        'ফরম্যাট (সংক্ষিপ্ত):\n' +
        '📊 *সাপ্তাহিক স্ট্র্যাটেজিক রিভিউ*\n' +
        'বিজনেস altitude (WoW সেল, টপ/বটম, রিটার্ন, নতুন vs রিপিট, ad spend যদি থাকে)\n' +
        'বাড়ছে / আটকে — ২-৩ clearest mover + সম্ভাব্য driver\n' +
        '🤖 আমার নিজের রিভিউ: পরামর্শ সংখ্যা, acceptance rate, outcome counts, ভুল (misses) স্পষ্টভাবে, কী adjust করব\n' +
        '🎯 আগামী সপ্তাহের ফোকাস: ২-৩ concrete data-backed priority\n\n' +
        'নিয়ম:\n' +
        '- শুধু দেওয়া সংখ্যা ব্যবহার করুন; অনুমান করবেন না।\n' +
        '- Misses অবশ্যই উল্লেখ করুন — শুধু win দেখাবেন না।\n' +
        '- Causation দাবি করবেন না; correlation ভাষা।\n' +
        '- সর্বোচ্চ ~৪০০ শব্দ।\n\n' +
        `DATA:\n${factsJson}`,
    }],
  })

  const block = res.content.find((b) => b.type === 'text')
  const text = block && block.type === 'text' ? block.text.trim() : ''
  if (!text) return fallbackMessage(data)

  const inputTokens = res.usage.input_tokens
  const outputTokens = res.usage.output_tokens
  const costUsd = calcAnthropicChatCostUsd({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  })

  void logCost({
    provider: 'anthropic',
    kind: 'chat',
    units: { input_tokens: inputTokens, output_tokens: outputTokens, model: AGENT_MODEL, purpose: 'weekly_strategic' },
    costUsd,
    dedupKey: `weekly-strategic:${data.period.thisWeekEnd}`,
  })

  return text
}

export async function buildWeeklyStrategicReview(): Promise<{ message: string; data: WeeklyStrategicData }> {
  const data = await gatherWeeklyStrategicData()
  const message = await narrateWeeklyStrategic(data)
  return { message, data }
}
