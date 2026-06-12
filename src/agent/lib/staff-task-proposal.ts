/**
 * Proactive staff task proposal — inventory, sales, FB, carry-forward.
 * Used by prepare_staff_task_proposal tool and evening-proposal worker job.
 */
import { prisma } from '@/lib/prisma'
import { serverGet } from '@/lib/server-api'
import { aggregateDashboardMetrics, filterOrdersByDateRange } from '@/lib/order-analytics'
import { listInventory } from '@/lib/agent-api/services/inventory.service'
import { listAgentOrders } from '@/lib/agent-api/orders.service'
import { addDaysYmd, todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { getRecentPosts, resolvePageId } from '@/agent/lib/meta'
import type { Order } from '@/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type ProposedTaskInput = {
  staffId: string
  staffName: string
  title: string
  detail?: string
  type: string
  productRef?: string
  source: string
}

type ScoredProduct = {
  productRef: string
  name: string
  business: string
  sales30d: number
  stock: number
  lastPromotedAt: Date | null
  score: number
  reasons: string[]
  taskType: string
}

function isContentStaff(staff: { name: string; role: string }) {
  return staff.role === 'content' || /eyafi/i.test(staff.name)
}

function scoreProduct(
  product: {
    sales30d: number
    stock: number
    lastPromotedAt: Date | null
    tags?: string[]
  },
  today = new Date(),
) {
  const { sales30d = 0, stock = 0, lastPromotedAt } = product
  const daysSincePromo = lastPromotedAt
    ? Math.floor((today.getTime() - lastPromotedAt.getTime()) / 86400000)
    : 999

  const reasons: string[] = []
  let score = 0
  const avgWeekly = sales30d / 4

  if (avgWeekly >= 10) {
    score += 100
    reasons.push(`বেস্টসেলার (${sales30d} পিস/৩০ দিন)`)
  } else if (avgWeekly >= 3) {
    score += 60
    reasons.push(`ভালো বিক্রি (${sales30d} পিস/৩০ দিন)`)
  } else {
    score += 20
    reasons.push('স্লো মুভার — প্রমোশন দরকার')
  }

  if (daysSincePromo >= 30) {
    score += daysSincePromo >= 60 ? 40 : 25
    reasons.push(`${daysSincePromo} দিন প্রমোশন হয়নি`)
  } else if (daysSincePromo < 2) {
    score -= 30
    reasons.push('সম্প্রতি প্রমোট হয়েছে')
  }

  if (stock > 20 && sales30d < 5) {
    score += Math.min(40, Math.floor(stock / 5))
    reasons.push(`স্টক প্রেশার: ${stock} স্টক, ${sales30d} বিক্রি`)
  } else if (stock === 0) {
    score -= 50
    reasons.push('স্টক শেষ')
  }

  let taskType = 'product_content'
  if (avgWeekly >= 10) taskType = 'ad_creative'
  else if (sales30d === 0 && stock > 0) taskType = 'listing_update'

  return { score, reasons, taskType }
}

function pickRotation(products: ScoredProduct[], today = new Date()) {
  const scored = products
    .map((p) => ({ ...p, ...scoreProduct(p, today) }))
    .sort((a, b) => b.score - a.score)

  let picks = scored.filter((p) => p.stock > 0).slice(0, 4)
  if (picks.length < 2) picks = scored.slice(0, 4)
  return picks
}

function buildTasksForStaff(
  staff: { id: string; name: string; role: string },
  picks: ScoredProduct[],
  carryForward: Array<{ staffId: string; title: string; detail: string | null; type: string; productRef: string | null }>,
  pendingOrders: number,
) {
  const tasks: Omit<ProposedTaskInput, 'staffName'>[] = []

  for (const carried of carryForward.filter((t) => t.staffId === staff.id)) {
    tasks.push({
      staffId: staff.id,
      title: `↩ ${carried.title} (গতকালের কাজ)`,
      detail: carried.detail ?? undefined,
      type: carried.type || 'misc',
      productRef: carried.productRef ?? undefined,
      source: 'pattern',
    })
  }

  if (isContentStaff(staff)) {
    for (const pick of picks.slice(0, 2)) {
      const type = pick.taskType || 'product_content'
      tasks.push({
        staffId: staff.id,
        title:
          type === 'ad_creative'
            ? `${pick.name} — FB/অ্যাড ক্রিয়েটিভ তৈরি করুন`
            : `${pick.name} — কন্টেন্ট ও পোস্ট তৈরি করুন`,
        detail: pick.reasons.slice(0, 3).join('; '),
        type,
        productRef: pick.productRef,
        source: 'rotation',
      })
    }
    if (pendingOrders > 0) {
      tasks.push({
        staffId: staff.id,
        title: `${pendingOrders}টি পেন্ডিং অর্ডার ফলো-আপ করুন`,
        detail: 'কাস্টমার কল/মেসেজ — কনফার্ম বা ডেলিভারি আপডেট',
        type: 'order_followup',
        source: 'pattern',
      })
    }
  } else {
    for (const pick of picks.slice(2, 4)) {
      tasks.push({
        staffId: staff.id,
        title: `${pick.name} — স্টক ও প্যাকিং চেক করুন`,
        detail: `বর্তমান স্টক: ${pick.stock}. ${pick.reasons[0] ?? ''}`,
        type: 'stock_check',
        productRef: pick.productRef,
        source: 'rotation',
      })
    }
    tasks.push({
      staffId: staff.id,
      title: 'COD অর্ডার কনফার্ম ও ডেলিভারি আপডেট করুন',
      detail: 'পেন্ডিং COD লিস্ট চেক করে কুরিয়ার/কাস্টমার আপডেট',
      type: 'order_followup',
      source: 'agent',
    })
    const lowStock = picks.find((p) => p.stock > 0 && p.stock <= 5)
    if (lowStock) {
      tasks.push({
        staffId: staff.id,
        title: `${lowStock.name} — লো স্টক রিপ্লেনিশ (${lowStock.stock} পিস বাকি)`,
        detail: 'ইনভেন্টরি আপডেট + মালিককে জানান',
        type: 'stock_check',
        productRef: lowStock.productRef,
        source: 'pattern',
      })
    }
  }

  return tasks.map((t) => ({ ...t, staffName: staff.name }))
}

function formatSummary(
  date: string,
  staffList: Array<{ name: string }>,
  tasks: ProposedTaskInput[],
  picks: ScoredProduct[],
  carryCount: number,
  pendingOrders: number,
) {
  const byStaff = staffList.map((s) => {
    const sTasks = tasks.filter((t) => t.staffName === s.name)
    return `*${s.name}* (${sTasks.length}টি):\n${sTasks.map((t) => `  • ${t.title}`).join('\n')}`
  })

  const topLine = picks
    .slice(0, 3)
    .map((p) => `  • ${p.name}: ${p.reasons[0] ?? ''}`)
    .join('\n')

  let msg =
    `📋 *আজকের স্টাফ টাস্ক প্রস্তাব* — ${date}\n\n` +
    byStaff.join('\n\n') +
    (topLine ? `\n\n🔥 *বেস্টসেলার/ফোকাস পণ্য (৩০ দিন):*\n${topLine}` : '') +
    (pendingOrders > 0 ? `\n\n📦 পেন্ডিং অর্ডার: ${pendingOrders}টি` : '')

  if (carryCount > 0) {
    msg += `\n\n⚠️ গতকালের ${carryCount}টি অসম্পূর্ণ কাজ যোগ করা হয়েছে।`
  }

  return msg
}

type PatternFlags = {
  staleProductTasks: ProposedTaskInput[]
  lateTypeFlags: string[]
  messengerAlertLine: string | null
}

async function detectPatterns(
  dateYmd: string,
  staffList: Array<{ id: string; name: string; role: string }>,
  inv: { items: Array<{ sku: string; name: string; currentStock: number }> },
  historyRows: Array<{ productRef: string; business: string; lastPromotedAt: Date }>,
): Promise<PatternFlags> {
  const staleProductTasks: ProposedTaskInput[] = []
  const lateTypeFlags: string[] = []
  let messengerAlertLine: string | null = null

  const cutoff30 = new Date(`${addDaysYmd(dateYmd, -30)}T00:00:00+06:00`)
  const recentPromo = new Map<string, Date>()
  for (const h of historyRows) {
    const k = `${h.business}:${h.productRef}`
    const prev = recentPromo.get(k)
    if (!prev || h.lastPromotedAt > prev) recentPromo.set(k, h.lastPromotedAt)
  }

  const contentStaff = staffList.find((s) => isContentStaff(s))
  for (const item of inv.items) {
    if (item.currentStock <= 0) continue
    const key = `ALMA Lifestyle:${item.sku}`
    const lastAt = recentPromo.get(key)
    if (lastAt && lastAt >= cutoff30) continue
    if (!contentStaff) continue
    const days = lastAt
      ? Math.floor((Date.now() - lastAt.getTime()) / 86400000)
      : 999
    staleProductTasks.push({
      staffId: contentStaff.id,
      staffName: contentStaff.name,
      title: `${item.name} — ৩০+ দিন মার্কেটিং হয়নি, কন্টেন্ট তৈরি করুন`,
      detail: `স্টক: ${item.currentStock}। ${days >= 999 ? 'কখনো প্রমোট হয়নি' : `${days} দিন প্রমোশন হয়নি`}`,
      type: 'product_content',
      productRef: item.sku,
      source: 'pattern',
    })
  }

  const from14 = new Date(`${addDaysYmd(dateYmd, -14)}T00:00:00+06:00`)
  const lateTasks = await db.agentStaffTask.findMany({
    where: {
      proposedFor: { gte: from14 },
      status: { in: ['carried', 'sent'] },
    },
    select: { type: true },
  })
  const typeCounts: Record<string, number> = {}
  for (const t of lateTasks) {
    const ty = t.type || 'misc'
    typeCounts[ty] = (typeCounts[ty] ?? 0) + 1
  }
  for (const [ty, count] of Object.entries(typeCounts)) {
    if (count >= 3) {
      const label = ty === 'stock_check' ? 'stock check' : ty.replace(/_/g, ' ')
      lateTypeFlags.push(`⚠️ ${label} ${count} বার late/carried (১৪ দিন)`)
    }
  }

  const alertCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const staleAlerts = await db.agentMessengerAlert.count({
    where: { resolved: false, detectedAt: { lt: alertCutoff } },
  })
  if (staleAlerts > 0) {
    messengerAlertLine = `📨 ${staleAlerts}টি Messenger alert ২৪+ ঘণ্টা unresolved — owner action দরকার`
  }

  return { staleProductTasks: staleProductTasks.slice(0, 3), lateTypeFlags, messengerAlertLine }
}

export async function buildStaffTaskProposal(dateYmd = todayYmdDhaka()) {
  const staffList = await db.agentStaff.findMany({
    where: { active: true },
    select: { id: true, name: true, role: true, telegramChatId: true },
    orderBy: { name: 'asc' },
  })

  if (!staffList.length) {
    return { success: false as const, error: 'কোনো active staff পাওয়া যায়নি' }
  }

  const yesterday = addDaysYmd(dateYmd, -1)
  const from30 = addDaysYmd(dateYmd, -30)

  const [carryRows, historyRows, inv, orders30, pendingRes, fbPosts] = await Promise.all([
    db.agentStaffTask.findMany({
      where: {
        proposedFor: new Date(`${yesterday}T00:00:00+06:00`),
        status: { in: ['sent', 'approved'] },
      },
      select: { staffId: true, title: true, detail: true, type: true, productRef: true },
    }),
    db.agentProductMarketingHistory.findMany({
      orderBy: { lastPromotedAt: 'asc' },
      take: 200,
    }),
    listInventory().catch(() => ({ items: [] as Array<{ sku: string; name: string; currentStock: number }> })),
    (async () => {
      try {
        const raw = await serverGet<{ orders?: Order[] }>('orders', { business_id: 'ALMA_LIFESTYLE', limit: '500' }, 0)
        const orders = raw.orders ?? []
        return filterOrdersByDateRange(orders, { start: from30, end: dateYmd })
      } catch {
        return [] as Order[]
      }
    })(),
    listAgentOrders({ status: 'pending', limit: 100 }).catch(() => ({ orders: [], meta: { count: 0 } })),
    getRecentPosts({ pageId: resolvePageId('lifestyle'), limit: 8 }).catch(() => []),
  ])

  const metrics = aggregateDashboardMetrics(orders30)
  const topProducts = metrics.top_products.slice(0, 15)

  const historyMap = new Map<string, Date>()
  for (const row of historyRows) {
    const key = `${row.business}:${row.productRef}`
    if (!historyMap.has(key)) historyMap.set(key, row.lastPromotedAt)
  }

  const stockMap = new Map(inv.items.map((i) => [i.sku, i]))

  const products: ScoredProduct[] = topProducts.map((tp) => {
    const stockItem = stockMap.get(tp.product) ?? [...stockMap.values()].find((s) => s.name === tp.product)
    return {
      productRef: tp.product,
      name: tp.product,
      business: 'ALMA Lifestyle',
      sales30d: tp.pieces,
      stock: stockItem?.currentStock ?? 0,
      lastPromotedAt: historyMap.get(`ALMA Lifestyle:${tp.product}`) ?? null,
      score: 0,
      reasons: [],
      taskType: 'product_content',
    }
  })

  if (products.length < 4) {
    for (const item of inv.items.filter((i) => i.currentStock > 0).slice(0, 10)) {
      if (products.some((p) => p.productRef === item.sku)) continue
      products.push({
        productRef: item.sku,
        name: item.name,
        business: 'ALMA Lifestyle',
        sales30d: 0,
        stock: item.currentStock,
        lastPromotedAt: historyMap.get(`ALMA Lifestyle:${item.sku}`) ?? null,
        score: 0,
        reasons: [],
        taskType: 'listing_update',
      })
    }
  }

  const picks = pickRotation(products)
  const pendingOrders = pendingRes.meta.count

  const patterns = await detectPatterns(dateYmd, staffList, inv, historyRows)

  const allTasks: ProposedTaskInput[] = []
  for (const staff of staffList) {
    allTasks.push(...buildTasksForStaff(staff, picks, carryRows, pendingOrders))
  }
  for (const pt of patterns.staleProductTasks) {
    if (!allTasks.some((t) => t.productRef === pt.productRef && t.type === pt.type)) {
      allTasks.push(pt)
    }
  }

  let summaryBangla = formatSummary(dateYmd, staffList, allTasks, picks, carryRows.length, pendingOrders)
  if (patterns.lateTypeFlags.length > 0) {
    summaryBangla += `\n\n*প্যাটার্ন সতর্কতা:*\n${patterns.lateTypeFlags.join('\n')}`
  }
  if (patterns.messengerAlertLine) {
    summaryBangla += `\n\n${patterns.messengerAlertLine}`
  }

  const fbRecent = Array.isArray(fbPosts)
    ? fbPosts.slice(0, 3).map((p: { message?: string; created_time?: string }) => ({
        snippet: (p.message ?? '').slice(0, 80),
        at: p.created_time,
      }))
    : []

  return {
    success: true as const,
    date: dateYmd,
    staff: staffList,
    tasks: allTasks,
    rotationPicks: picks.map((p) => ({
      productRef: p.productRef,
      name: p.name,
      sales30d: p.sales30d,
      stock: p.stock,
      reasons: p.reasons,
      taskType: p.taskType,
    })),
    carryForwardCount: carryRows.length,
    pendingOrders,
    topProducts: topProducts.slice(0, 5).map((p) => ({
      product: p.product,
      pieces: p.pieces,
      revenue: p.revenue,
    })),
    fbRecent,
    summaryBangla,
    note: 'ডেটা: ইনভেন্টরি + ৩০ দিনের অর্ডার + FB পোস্ট + গতকালের carry-forward',
  }
}
