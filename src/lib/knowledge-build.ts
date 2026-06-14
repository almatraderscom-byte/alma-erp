/**
 * Nightly deterministic knowledge graph builder — real data only, no LLM.
 */
import { prisma } from '@/lib/prisma'
import { getInventoryWithSales } from '@/lib/inventory-with-sales'
import { analyzePricing } from '@/lib/pricing-insight'
import { segmentCustomers } from '@/lib/customer-intelligence'
import { getAgentOrdersSummary } from '@/lib/agent-api/orders.service'
import { todayYmdDhaka, daysAgoYmd } from '@/lib/agent-api/dhaka-date'
import { learnFact } from '@/lib/knowledge-graph'
import { seasonalMultiplier } from '@/lib/inventory-forecast'
import { roundMoney } from '@/lib/money'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const GLOBAL = '_global'

function bdSeasonContext(month: number): { season: string; note: string } {
  if (month === 3 || month === 4) {
    return { season: 'eid_fitr_buildup', note: 'রমজান/ঈদুল ফিতর সিজন — পাঞ্জাবি/ফ্যামিলি demand বাড়তে পারে' }
  }
  if (month === 5 || month === 6) {
    return { season: 'eid_adha', note: 'ঈদুল আযহা সিজন — traditional wear demand' }
  }
  if (month === 9 || month === 10) {
    return { season: 'durga_puja', note: 'দুর্গা পূজা সিজন — শাড়ি/জুয়েলারি demand' }
  }
  if (month === 11 || month === 12 || month === 1) {
    return { season: 'winter', note: 'শীতকাল — warm wear demand' }
  }
  if (month === 2) {
    return { season: 'pahela_baishakh', note: 'পহেলা বৈশাখ — traditional/panjabi demand' }
  }
  return { season: 'regular', note: 'নিয়মিত retail সিজন' }
}

async function buildProductFacts(): Promise<number> {
  let count = 0
  const products = await getInventoryWithSales()
  const pricing = await analyzePricing().catch(() => null)
  const thinMap = new Map(
    (pricing?.thinMargin ?? []).map((t) => [t.product.toLowerCase(), t.marginPct]),
  )

  const month = new Date().getMonth() + 1
  const season = bdSeasonContext(month)

  for (const p of products.filter((x) => (x.sales30d ?? 0) > 0).slice(0, 25)) {
    const weekly = Math.round(((p.sales30d ?? 0) / 30) * 7 * 10) / 10
    const rate30 = (p.sales30d ?? 0) / 30
    const rate90 = (p.sales90d ?? 0) / 90
    let trend = 'স্থিতিশীল'
    if (rate90 > 0 && rate30 > rate90 * 1.15) trend = 'বাড়ছে'
    else if (rate90 > 0 && rate30 < rate90 * 0.85) trend = 'কমছে'

    const tags = p.tags ?? []
    const mult = seasonalMultiplier(new Date(), tags)
    const seasonalNote =
      mult >= 1.15
        ? `${season.note} (seasonal multiplier ~${mult})`
        : season.note

    await learnFact({
      entityType: 'product',
      entityId: p.id,
      entityName: p.name,
      attribute: 'avg_weekly_sales',
      value: `গড়ে সপ্তাহে ~${weekly}টি বিক্রি (৩০ দিনের ডেটা)`,
      source: 'sales_data',
    })
    count++

    await learnFact({
      entityType: 'product',
      entityId: p.id,
      entityName: p.name,
      attribute: 'sales_trend',
      value: `বিক্রি ট্রেন্ড: ${trend}`,
      source: 'sales_data',
    })
    count++

    await learnFact({
      entityType: 'product',
      entityId: p.id,
      entityName: p.name,
      attribute: 'seasonality',
      value: seasonalNote,
      source: 'derived',
      confidenceDelta: 0.03,
    })
    count++

    const margin = thinMap.get(p.name.toLowerCase())
    if (margin != null) {
      const band = margin < 10 ? 'খুব কম' : margin < 15 ? 'কম' : 'মাঝারি'
      await learnFact({
        entityType: 'product',
        entityId: p.id,
        entityName: p.name,
        attribute: 'margin_band',
        value: `মার্জিন ~${margin}% (${band})`,
        source: 'sales_data',
      })
      count++
    }
  }

  return count
}

async function buildSegmentFacts(): Promise<number> {
  let count = 0
  const seg = await segmentCustomers()

  if (seg.winBack.length) {
    const avgGap =
      seg.winBack.reduce((s, c) => s + (c.daysSinceLastOrder ?? 0), 0) / seg.winBack.length
    await learnFact({
      entityType: 'customer_segment',
      entityId: 'win_back',
      entityName: 'Win-back',
      attribute: 'avg_order_gap_days',
      value: `৪৫+ দিন নেই এমন repeat buyer — গড় ${Math.round(avgGap)} দিন gap (${seg.winBack.length} জন)`,
      source: 'sales_data',
    })
    count++
  }

  if (seg.loyal.length) {
    const avgOrders = seg.loyal.reduce((s, c) => s + c.ordersCount, 0) / seg.loyal.length
    await learnFact({
      entityType: 'customer_segment',
      entityId: 'loyal',
      entityName: 'Loyal',
      attribute: 'repeat_rate',
      value: `Loyal cohort গড় ${Math.round(avgOrders)}টি অর্ডার (${seg.loyal.length} জন top)`,
      source: 'sales_data',
    })
    count++
  }

  if (seg.atRisk.length) {
    await learnFact({
      entityType: 'customer_segment',
      entityId: 'at_risk',
      entityName: 'At-risk',
      attribute: 'churn_risk',
      value: `${seg.atRisk.length} জন repeat buyer ৩০–৪৫ দিন নেই — early win-back window`,
      source: 'sales_data',
    })
    count++
  }

  return count
}

async function buildStaffFacts(): Promise<number> {
  let count = 0
  const from = daysAgoYmd(30)
  const tasks = await db.agentStaffTask.findMany({
    where: {
      proposedFor: { gte: new Date(`${from}T00:00:00+06:00`) },
      status: { notIn: ['cancelled', 'proposed'] },
      type: { not: 'learning' },
    },
    include: { staff: { select: { id: true, name: true } } },
  }) as Array<{
    staffId: string
    type: string
    status: string
    staff: { id: string; name: string }
  }>

  const DONE = new Set(['done', 'verified', 'done_unverified', 'awaiting_proof'])
  const byStaff = new Map<string, { name: string; byType: Record<string, { done: number; total: number }>; done: number; total: number }>()

  for (const t of tasks) {
    const sid = t.staffId
    const name = t.staff?.name ?? 'স্টাফ'
    if (!byStaff.has(sid)) {
      byStaff.set(sid, { name, byType: {}, done: 0, total: 0 })
    }
    const s = byStaff.get(sid)!
    s.total++
    if (DONE.has(t.status)) s.done++
    s.byType[t.type] ??= { done: 0, total: 0 }
    s.byType[t.type].total++
    if (DONE.has(t.status)) s.byType[t.type].done++
  }

  for (const [staffId, s] of byStaff) {
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0
    await learnFact({
      entityType: 'staff',
      entityId: staffId,
      entityName: s.name,
      attribute: 'reliability',
      value: `গত ৩০ দিনে ${pct}% টাস্ক completion (${s.done}/${s.total})`,
      source: 'sales_data',
    })
    count++

    let bestType = ''
    let bestPct = 0
    for (const [type, stats] of Object.entries(s.byType)) {
      const p = stats.total ? stats.done / stats.total : 0
      if (p > bestPct && stats.total >= 3) {
        bestPct = p
        bestType = type
      }
    }
    if (bestType) {
      await learnFact({
        entityType: 'staff',
        entityId: staffId,
        entityName: s.name,
        attribute: 'strength',
        value: `সবচেয়ে ভালো: ${bestType} (${Math.round(bestPct * 100)}% completion)`,
        source: 'derived',
      })
      count++
    }
  }

  return count
}

async function buildSeasonFacts(): Promise<number> {
  const month = new Date().getMonth() + 1
  const season = bdSeasonContext(month)
  const ymd = todayYmdDhaka()

  await learnFact({
    entityType: 'season',
    entityId: `${ymd.slice(0, 7)}`,
    entityName: season.season,
    attribute: 'peak_context',
    value: season.note,
    source: 'derived',
    confidenceDelta: 0.08,
  })

  return 1
}

async function buildBusinessFacts(): Promise<number> {
  let count = 0
  try {
    const [yesterday, week] = await Promise.all([
      getAgentOrdersSummary('yesterday'),
      getAgentOrdersSummary('week'),
    ])
    const weekRev = roundMoney(week.totalRevenue)
    const dayAvg = Math.round(weekRev / 7)
    const yRev = roundMoney(yesterday.totalRevenue)
    let trend = 'স্থিতিশীল'
    if (dayAvg > 0 && yRev > dayAvg * 1.15) trend = 'গতকাল গড়ের উপরে'
    else if (dayAvg > 0 && yRev < dayAvg * 0.85) trend = 'গতকাল গড়ের নিচে'

    await learnFact({
      entityType: 'business',
      entityId: GLOBAL,
      entityName: 'ALMA Lifestyle',
      attribute: 'overall_trend',
      value: `৭ দিনের গড় সেল ~৳${dayAvg}/দিন — ${trend}`,
      source: 'sales_data',
    })
    count++
  } catch { /* skip */ }

  return count
}

async function foldOutcomeLearnings(): Promise<number> {
  let count = 0

  const outcomes = await db.agentOutcome.findMany({
    where: { result: 'worked', learning: { not: null } },
    orderBy: { measuredAt: 'desc' },
    take: 30,
  }) as Array<{
    type: string
    subjectKind: string
    subjectId: string | null
    subjectName: string | null
    learning: string
    rationale: string | null
  }>

  for (const o of outcomes) {
    const entityType =
      o.subjectKind === 'product' ? 'product'
        : o.subjectKind === 'customer' ? 'customer_segment'
          : o.subjectKind === 'staff' ? 'staff'
            : o.subjectKind === 'campaign' ? 'channel'
              : 'business'

    await learnFact({
      entityType,
      entityId: o.subjectId ?? GLOBAL,
      entityName: o.subjectName ?? undefined,
      attribute: `outcome_${o.type}`,
      value: o.learning,
      source: 'outcome_loop',
      confidenceDelta: 0.1,
    })
    count++

    if (o.type === 'content' && o.subjectId) {
      const rationale = o.rationale ?? ''
      const typeFromRationale = rationale.match(/video_reel|product_content|ad_creative|fb_photo|fb_text|product_photo/i)?.[0]
      const typeHint = typeFromRationale ?? 'content'
      await learnFact({
        entityType: 'product',
        entityId: o.subjectId,
        entityName: o.subjectName ?? undefined,
        attribute: 'best_content_type',
        value: `${typeHint}: কন্টেন্ট পরামর্শের পর বিক্রিতে সংযুক্ত উন্নতি — ${o.learning}`,
        source: 'outcome_loop',
        confidenceDelta: 0.12,
      })
      count++
    }
  }

  const memories = await db.agentMemory.findMany({
    where: { scope: 'business' },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { content: true, metadata: true },
  })

  for (const m of memories) {
    const meta = m.metadata as { type?: string; suggestionType?: string } | null
    if (meta?.type !== 'outcome_learning') continue
    const st = meta.suggestionType ?? 'general'
    await learnFact({
      entityType: 'business',
      entityId: GLOBAL,
      entityName: 'ALMA',
      attribute: `learning_${st}`,
      value: m.content,
      source: 'outcome_loop',
      confidenceDelta: 0.06,
    })
    count++
  }

  return count
}

async function buildFinancialFacts(): Promise<number> {
  const { analyzeAndPersistFinancials } = await import('@/lib/financial-intelligence')
  await analyzeAndPersistFinancials(30)
  return 3
}

export async function buildBusinessKnowledge(): Promise<{ factsWritten: number; errors: string[] }> {
  const errors: string[] = []
  let factsWritten = 0

  const steps: Array<[string, () => Promise<number>]> = [
    ['products', buildProductFacts],
    ['segments', buildSegmentFacts],
    ['staff', buildStaffFacts],
    ['season', buildSeasonFacts],
    ['business', buildBusinessFacts],
    ['outcomes', foldOutcomeLearnings],
    ['financial', buildFinancialFacts],
  ]

  for (const [name, fn] of steps) {
    try {
      factsWritten += await fn()
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { factsWritten, errors }
}
