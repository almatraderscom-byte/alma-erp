/**
 * Owner morning briefing — shared data gatherers (Vercel agent tool + internal API + worker).
 */
import { prisma } from '@/lib/prisma'
import {
  getAgentOrdersSummary,
  listAgentOrders,
} from '@/lib/agent-api/orders.service'
import { listInventory } from '@/lib/agent-api/services/inventory.service'
import { getMessengerInbox, resolvePageId } from '@/agent/lib/meta'
import { searchAgentMemory } from '@/agent/lib/memory-search'
import { todayYmdDhaka, daysAgoYmd } from '@/lib/agent-api/dhaka-date'
import { roundMoney } from '@/lib/money'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type BriefingDecision = {
  area: string
  urgency: 'high' | 'normal'
  text: string
  recommend: string
}

export type OwnerBriefingData = {
  today: string
  sales: {
    yesterdayTotal: number
    yesterdayOrders: number
    sevenDayAvg: number
    sevenDayOrderAvg: number
  } | null
  pendingOrders: { count: number; sheetSyncedAt: string | null } | null
  inventory: { items: Array<{ name: string; currentStock: number; reorderLevel: number; sku: string }> } | null
  csWaiting: { unrepliedCount: number; nearWindowCount: number; openAlerts: number } | null
  adsDigest: {
    campaigns: Array<{ name: string; spend: number; ctr: number; cpc: number }>
    anomalies: Array<{ campaign: string; dropPct: number }>
  } | null
  staffYesterday: {
    summary: string
    done: number
    total: number
    lowPerformers: Array<{ name: string; pct: number; daysLow: number }>
  } | null
  decisions: BriefingDecision[]
  ownerDecisionMemoryCount: number
  generatedAt: string
}

async function gatherSalesSignals() {
  try {
    const [yesterday, week] = await Promise.all([
      getAgentOrdersSummary('yesterday'),
      getAgentOrdersSummary('week'),
    ])
    return {
      yesterdayTotal: roundMoney(yesterday.totalRevenue),
      yesterdayOrders: yesterday.totalOrders,
      sevenDayAvg: Math.round(roundMoney(week.totalRevenue) / 7),
      sevenDayOrderAvg: Math.round(week.totalOrders / 7),
    }
  } catch {
    return null
  }
}

async function gatherPendingOrders() {
  try {
    const { meta } = await listAgentOrders({ status: 'pending', limit: 100 })
    return { count: meta.count, sheetSyncedAt: meta.sheetSyncedAt ?? null }
  } catch {
    return null
  }
}

async function gatherLowStock() {
  try {
    const inv = await listInventory()
    const items = inv.items
      .filter((i) => i.currentStock <= (i.reorderLevel || 1) || i.currentStock === 0)
      .slice(0, 10)
      .map((i) => ({
        name: i.name,
        currentStock: i.currentStock,
        reorderLevel: i.reorderLevel ?? 0,
        sku: i.sku,
      }))
    return { items }
  } catch {
    return null
  }
}

async function gatherCsWaiting() {
  try {
    const [lifeThreads, shopThreads, openAlerts] = await Promise.all([
      getMessengerInbox({ pageId: resolvePageId('lifestyle'), limit: 15 }).catch(() => []),
      getMessengerInbox({ pageId: resolvePageId('onlineshop'), limit: 15 }).catch(() => []),
      db.agentMessengerAlert.count({ where: { resolved: false } }).catch(() => 0),
    ])
    const all = [...lifeThreads, ...shopThreads]
    const unreplied = all.filter((t) => t.needsReply)
    const nearWindow = all.filter((t) => (t.unansweredMinutes ?? 0) >= 22 * 60)
    return {
      unrepliedCount: unreplied.length,
      nearWindowCount: nearWindow.length,
      openAlerts: Number(openAlerts) || 0,
    }
  } catch {
    return null
  }
}

function safeNum(v: unknown) {
  const n = parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

async function gatherAdsDigest() {
  const token = process.env.META_ADS_TOKEN
  const accountId = process.env.META_AD_ACCOUNT_ID
  if (!token || !accountId) return null

  try {
    const today = new Date().toISOString().slice(0, 10)
    const sevenDaysAgo = daysAgoYmd(6)
    const campRes = await fetch(
      `https://graph.facebook.com/v21.0/${accountId}/campaigns?effective_status=["ACTIVE"]&fields=id,name&limit=10&access_token=${token}`,
    )
    if (!campRes.ok) return null
    const campData = (await campRes.json()) as { data?: Array<{ id: string; name: string }> }
    const campaigns: OwnerBriefingData['adsDigest'] extends null ? never : NonNullable<OwnerBriefingData['adsDigest']>['campaigns'] = []
    const anomalies: Array<{ campaign: string; dropPct: number }> = []

    for (const c of campData.data ?? []) {
      const todayUrl = `https://graph.facebook.com/v21.0/${c.id}/insights?time_range=${encodeURIComponent(JSON.stringify({ since: today, until: today }))}&fields=spend,ctr,cpc&access_token=${token}`
      const weekUrl = `https://graph.facebook.com/v21.0/${c.id}/insights?time_range=${encodeURIComponent(JSON.stringify({ since: sevenDaysAgo, until: today }))}&fields=ctr&access_token=${token}`
      const [todayIns, weekIns] = await Promise.all([fetch(todayUrl), fetch(weekUrl)])
      if (!todayIns.ok) continue
      const todayData = (await todayIns.json()) as { data?: Array<{ spend?: string; ctr?: string; cpc?: string }> }
      const weekData = weekIns.ok
        ? ((await weekIns.json()) as { data?: Array<{ ctr?: string }> })
        : { data: [] }
      const t = todayData.data?.[0]
      const w = weekData.data?.[0]
      const ctr = safeNum(t?.ctr)
      const weekCtr = safeNum(w?.ctr)
      campaigns.push({
        name: c.name,
        spend: Math.round(safeNum(t?.spend)),
        ctr: Math.round(ctr * 10000) / 100,
        cpc: Math.round(safeNum(t?.cpc) * 100) / 100,
      })
      if (weekCtr > 0 && ctr < weekCtr * 0.6 && safeNum(t?.spend) > 0) {
        anomalies.push({
          campaign: c.name,
          dropPct: Math.round((1 - ctr / weekCtr) * 100),
        })
      }
    }
    return campaigns.length ? { campaigns, anomalies } : null
  } catch {
    return null
  }
}

async function gatherStaffYesterday() {
  try {
    const yesterdayYmd = daysAgoYmd(1)
    const tasks = await db.agentStaffTask.findMany({
      where: {
        proposedFor: new Date(yesterdayYmd),
        status: { notIn: ['cancelled'] },
      },
      include: { staff: { select: { id: true, name: true } } },
    })
    const work = tasks.filter((t: { type: string }) => t.type !== 'learning')
    const done = work.filter((t: { status: string }) => t.status === 'done')
    const summary = `${done.length}/${work.length} কাজ শেষ`

    const lowPerformers: Array<{ name: string; pct: number; daysLow: number }> = []
    const staffIds = [...new Set(work.map((t: { staffId: string }) => t.staffId))]
    for (const staffId of staffIds) {
      let daysLow = 0
      const name = work.find((t: { staffId: string }) => t.staffId === staffId)?.staff?.name ?? 'স্টাফ'
      for (let d = 1; d <= 3; d++) {
        const ymd = daysAgoYmd(d)
        const dayTasks = await db.agentStaffTask.findMany({
          where: {
            staffId,
            proposedFor: new Date(ymd),
            status: { notIn: ['cancelled'] },
            type: { not: 'learning' },
          },
          select: { status: true },
        })
        if (!dayTasks.length) continue
        const dayDone = dayTasks.filter((t: { status: string }) => t.status === 'done').length
        const pct = Math.round((dayDone / dayTasks.length) * 100)
        if (pct < 50) daysLow++
      }
      if (daysLow >= 2) {
        const yTasks = work.filter((t: { staffId: string }) => t.staffId === staffId)
        const yDone = yTasks.filter((t: { status: string }) => t.status === 'done').length
        lowPerformers.push({
          name,
          pct: yTasks.length ? Math.round((yDone / yTasks.length) * 100) : 0,
          daysLow,
        })
      }
    }

    return { summary, done: done.length, total: work.length, lowPerformers }
  } catch {
    return null
  }
}

export function deriveBriefingDecisions(sig: {
  sales: OwnerBriefingData['sales']
  pendingOrders: OwnerBriefingData['pendingOrders']
  inventory: OwnerBriefingData['inventory']
  csWaiting: OwnerBriefingData['csWaiting']
  adsDigest: OwnerBriefingData['adsDigest']
  staffYesterday: OwnerBriefingData['staffYesterday']
}): BriefingDecision[] {
  const decisions: BriefingDecision[] = []

  const lowBest = (sig.inventory?.items ?? []).filter(
    (i) => i.currentStock <= i.reorderLevel || i.currentStock === 0,
  )
  for (const item of lowBest.slice(0, 3)) {
    decisions.push({
      area: 'stock',
      urgency: item.currentStock === 0 ? 'high' : 'normal',
      text: `${item.name} স্টক কম (${item.currentStock}টি) — রিঅর্ডার করবেন?`,
      recommend: 'সাপ্লায়ারকে আজ অর্ডার দিন',
    })
  }

  if (
    sig.sales?.yesterdayTotal != null &&
    sig.sales?.sevenDayAvg != null &&
    sig.sales.sevenDayAvg > 0 &&
    sig.sales.yesterdayTotal < sig.sales.sevenDayAvg * 0.7
  ) {
    const dropPct = Math.round((1 - sig.sales.yesterdayTotal / sig.sales.sevenDayAvg) * 100)
    decisions.push({
      area: 'sales',
      urgency: 'high',
      text: `গতকালের সেল গড়ের চেয়ে ${dropPct}% কম (৳${sig.sales.yesterdayTotal} vs গড় ৳${sig.sales.sevenDayAvg})।`,
      recommend: 'একটি বেস্টসেলারে আজ ad boost দিন বা অফার চালু করুন',
    })
  }

  const pendingCount = sig.pendingOrders?.count ?? 0
  if (pendingCount >= 10) {
    decisions.push({
      area: 'orders',
      urgency: 'high',
      text: `${pendingCount}টি pending অর্ডার জমে আছে।`,
      recommend: 'স্টাফকে আজ কনফার্ম/ডেলিভারি push করতে বলুন',
    })
  }

  const nearWindow = sig.csWaiting?.nearWindowCount ?? 0
  if (nearWindow > 0) {
    decisions.push({
      area: 'customers',
      urgency: 'high',
      text: `${nearWindow} জন কাস্টমারের 24h window প্রায় শেষ।`,
      recommend: 'এখনই reply করুন — না হলে আর মেসেজ পাঠানো যাবে না',
    })
  } else if ((sig.csWaiting?.unrepliedCount ?? 0) >= 5) {
    decisions.push({
      area: 'customers',
      urgency: 'normal',
      text: `${sig.csWaiting!.unrepliedCount}টি unreplied মেসেজ আছে।`,
      recommend: 'আজ সকালে inbox clear করুন',
    })
  }

  for (const a of (sig.adsDigest?.anomalies ?? []).slice(0, 2)) {
    decisions.push({
      area: 'ads',
      urgency: 'normal',
      text: `${a.campaign}: CTR গড়ের চেয়ে ${a.dropPct}% কম।`,
      recommend: 'নতুন creative বা audience টেস্ট করুন',
    })
  }

  for (const s of (sig.staffYesterday?.lowPerformers ?? []).slice(0, 2)) {
    decisions.push({
      area: 'staff',
      urgency: 'normal',
      text: `${s.name} গত ${s.daysLow} দিন ধরে কাজ কম শেষ করছ (${s.pct}%)।`,
      recommend: 'আজকের টাস্ক সরল করুন বা সরাসরি ফলো-আপ করুন',
    })
  }

  return decisions
}

/** Remove decisions the owner previously vetoed via saved memory. */
export function filterVetoedDecisions(
  decisions: BriefingDecision[],
  ownerMemories: Array<{ content?: string }>,
): BriefingDecision[] {
  if (!ownerMemories.length) return decisions
  const vetoTexts = ownerMemories.map((m) => (m.content || '').toLowerCase())

  return decisions.filter((d) => {
    const text = `${d.text} ${d.recommend}`.toLowerCase()
    for (const veto of vetoTexts) {
      if (!veto) continue
      if (veto.includes('ad boost') && /(না|no|করো না|avoid)/.test(veto) && text.includes('ad boost')) {
        const vetoProduct = veto.match(/(fm[-\w\d]+)/i)?.[1]
        const sugProduct = text.match(/(fm[-\w\d]+)/i)?.[1]
        if (!vetoProduct || !sugProduct || vetoProduct === sugProduct) return false
      }
      if (/(না|no|করো না|avoid|বাদ)/.test(veto)) {
        const tokens = veto.split(/\s+/).filter((w) => w.length > 4)
        const overlap = tokens.filter((t) => text.includes(t)).length
        if (overlap >= 2) return false
      }
    }
    return true
  })
}

export async function buildOwnerBriefingData(): Promise<OwnerBriefingData> {
  const today = todayYmdDhaka()
  const [sales, pendingOrders, inventory, csWaiting, adsDigest, staffYesterday, ownerMemories] =
    await Promise.all([
      gatherSalesSignals(),
      gatherPendingOrders(),
      gatherLowStock(),
      gatherCsWaiting(),
      gatherAdsDigest(),
      gatherStaffYesterday(),
      searchAgentMemory({
        query: 'owner decision preference veto briefing',
        scope: 'business',
        limit: 8,
        metadataType: 'owner_decision',
      }).catch(() => []),
    ])

  const signals = { sales, pendingOrders, inventory, csWaiting, adsDigest, staffYesterday }
  let decisions = deriveBriefingDecisions(signals)
  decisions = filterVetoedDecisions(decisions, ownerMemories)

  return {
    today,
    ...signals,
    decisions,
    ownerDecisionMemoryCount: ownerMemories.length,
    generatedAt: new Date().toISOString(),
  }
}
