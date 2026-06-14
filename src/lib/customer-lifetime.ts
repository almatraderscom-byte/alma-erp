/**
 * Customer lifetime intelligence — tiers, churn risk, CLV (when data allows), personalization.
 */
import { prisma } from '@/lib/prisma'
import { getLifestyleOrders } from '@/lib/lifestyle/read'
import { todayYmdDhaka, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { filterOrdersByDateRange } from '@/lib/order-analytics'
import { learnFact } from '@/lib/knowledge-graph'
import { roundMoney } from '@/lib/money'
import type { Order } from '@/types'

const DAY = 86_400_000

export interface CustomerProfile {
  id: string
  name?: string | null
  phone?: string | null
  ordersCount: number
  avgOrderValue?: number
  estimatedClv?: number
  daysSinceLast?: number | null
  avgGapDays?: number | null
  churnRisk: 'low' | 'medium' | 'high'
  tier: 'vip' | 'regular' | 'occasional' | 'new'
  sizesNoted?: Record<string, unknown>
  tags?: unknown[]
  engagementSuggestion: string
  clvNote?: string
}

export type CustomerLifetimeDigest = {
  vipCount: number
  highChurnCount: number
  newThisWeekCount: number
  topVips: CustomerProfile[]
  highChurn: CustomerProfile[]
  newThisWeek: CustomerProfile[]
  notes: string[]
  formatted: string
}

function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const p = phone.replace(/\D/g, '')
  return p.length >= 10 ? p : null
}

async function fetchGasOrders(): Promise<Order[]> {
  try {
    const raw = await getLifestyleOrders({ business_id: 'ALMA_LIFESTYLE', limit: '500' })
    return raw.orders ?? []
  } catch {
    return []
  }
}

type PhoneOrderStats = {
  amounts: number[]
  dates: Date[]
}

function buildPhoneOrderStats(orders: Order[]): Map<string, PhoneOrderStats> {
  const map = new Map<string, PhoneOrderStats>()
  for (const o of orders) {
    const phone = normalizePhone(o.phone)
    if (!phone) continue
    const amt = roundMoney(Number(o.sell_price ?? 0))
    if (amt <= 0) continue
    const dateStr = String(o.date ?? '').slice(0, 10)
    const date = dateStr ? new Date(`${dateStr}T12:00:00Z`) : null
    if (!date || Number.isNaN(date.getTime())) continue

    const row = map.get(phone) ?? { amounts: [], dates: [] }
    row.amounts.push(amt)
    row.dates.push(date)
    map.set(phone, row)
  }
  return map
}

function computeAvgGapDays(dates: Date[]): number | null {
  if (dates.length < 2) return null
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime())
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(Math.floor((sorted[i]!.getTime() - sorted[i - 1]!.getTime()) / DAY))
  }
  if (!gaps.length) return null
  return Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)
}

function parseSizesNoted(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return {}
}

function parseTags(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : []
}

function sizeHint(sizes: Record<string, unknown>): string | null {
  const parts: string[] = []
  for (const [k, v] of Object.entries(sizes)) {
    if (v == null || v === '') continue
    parts.push(`${String(v)} ${k}`)
  }
  return parts.length ? parts.slice(0, 2).join(', ') : null
}

function computeTier(ordersCount: number, estimatedClv?: number): CustomerProfile['tier'] {
  if (ordersCount >= 5 || (estimatedClv != null && estimatedClv >= 25000)) return 'vip'
  if (ordersCount >= 2) return 'regular'
  if (ordersCount === 1) return 'occasional'
  return 'new'
}

function computeChurnRisk(
  ordersCount: number,
  daysSinceLast: number | null,
  avgGapDays: number | null,
): CustomerProfile['churnRisk'] {
  if (ordersCount < 2 || daysSinceLast == null) return 'low'
  if (avgGapDays != null && avgGapDays > 0) {
    if (daysSinceLast > avgGapDays * 2.5) return 'high'
    if (daysSinceLast > avgGapDays * 1.5) return 'medium'
    return 'low'
  }
  if (daysSinceLast > 90) return 'high'
  if (daysSinceLast > 45) return 'medium'
  return 'low'
}

function buildEngagementSuggestion(profile: {
  tier: CustomerProfile['tier']
  churnRisk: CustomerProfile['churnRisk']
  sizesNoted: Record<string, unknown>
  ordersCount: number
  daysSinceLast?: number | null
}): string {
  const hint = sizeHint(profile.sizesNoted)
  const ownerNote = ' (owner-facing — Meta 24h rule, auto-DM নয়)'

  if (profile.tier === 'vip') {
    return `VIP — thank-you, early access বা ছোট perk দিন। Relationship রক্ষা করুন${ownerNote}`
  }
  if (profile.churnRisk === 'high' && profile.ordersCount >= 2) {
    let msg = 'Win-back priority — ব্যক্তিগত অফার/মেসেজ ড্রাফ্ট করুন'
    if (hint) msg += `। আগে ${hint} কিনেছেন — নতুন কালেকশন জানান`
    return msg + ownerNote
  }
  if (profile.tier === 'occasional' && (profile.daysSinceLast ?? 99) <= 14) {
    return `নতুন কাস্টমার — welcome + second-purchase nudge${hint ? ` (${hint} preference মনে রাখুন)` : ''}${ownerNote}`
  }
  if (profile.churnRisk === 'medium') {
    return `Churn risk medium — আগামী সপ্তাহে follow-up করুন${hint ? ` (${hint})` : ''}${ownerNote}`
  }
  return `Regular care — personalized message when in 24h window${ownerNote}`
}

export async function buildCustomerProfiles(): Promise<CustomerProfile[]> {
  const [customers, orders] = await Promise.all([
    prisma.csCustomer.findMany({
      select: {
        id: true,
        name: true,
        phone: true,
        ordersCount: true,
        lastOrderAt: true,
        sizesNoted: true,
        tags: true,
      },
    }),
    fetchGasOrders(),
  ])

  const phoneStats = buildPhoneOrderStats(orders)
  const now = Date.now()

  return customers.map((c) => {
    const phone = normalizePhone(c.phone)
    const stats = phone ? phoneStats.get(phone) : undefined
    const daysSinceLast = c.lastOrderAt
      ? Math.floor((now - c.lastOrderAt.getTime()) / DAY)
      : null

    let avgOrderValue: number | undefined
    let estimatedClv: number | undefined
    let avgGapDays: number | null = null
    let clvNote: string | undefined

    if (stats && stats.amounts.length) {
      avgOrderValue = roundMoney(
        stats.amounts.reduce((s, a) => s + a, 0) / stats.amounts.length,
      )
      estimatedClv = roundMoney(avgOrderValue * Math.max(c.ordersCount, stats.amounts.length))
      avgGapDays = computeAvgGapDays(stats.dates)
    } else if (c.ordersCount > 0) {
      clvNote = 'Order amount/date ERP-তে phone match নেই — CLV অনুমান করা যায়নি'
    }

    const sizesNoted = parseSizesNoted(c.sizesNoted)
    const tags = parseTags(c.tags)
    const tier = computeTier(c.ordersCount, estimatedClv)
    const churnRisk = computeChurnRisk(c.ordersCount, daysSinceLast, avgGapDays)

    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      ordersCount: c.ordersCount,
      avgOrderValue,
      estimatedClv,
      daysSinceLast,
      avgGapDays,
      churnRisk,
      tier,
      sizesNoted,
      tags,
      engagementSuggestion: buildEngagementSuggestion({
        tier,
        churnRisk,
        sizesNoted,
        ordersCount: c.ordersCount,
        daysSinceLast,
      }),
      clvNote,
    }
  })
}

export function filterProfiles(
  profiles: CustomerProfile[],
  filter?: 'vip' | 'high_churn' | 'all',
): CustomerProfile[] {
  if (filter === 'vip') return profiles.filter((p) => p.tier === 'vip')
  if (filter === 'high_churn') {
    return profiles.filter((p) => p.churnRisk === 'high' && p.ordersCount >= 2)
  }
  return profiles
}

export async function buildCustomerLifetimeDigest(): Promise<CustomerLifetimeDigest> {
  const profiles = await buildCustomerProfiles()
  const weekStart = addDaysYmd(todayYmdDhaka(), -6)

  const topVips = profiles
    .filter((p) => p.tier === 'vip')
    .sort((a, b) => (b.estimatedClv ?? b.ordersCount) - (a.estimatedClv ?? a.ordersCount))
    .slice(0, 8)

  const highChurn = profiles
    .filter((p) => p.churnRisk === 'high' && p.ordersCount >= 2)
    .sort((a, b) => (b.ordersCount - a.ordersCount) || ((b.daysSinceLast ?? 0) - (a.daysSinceLast ?? 0)))
    .slice(0, 10)

  const orders = await fetchGasOrders()
  const weekOrders = filterOrdersByDateRange(orders, { start: weekStart, end: todayYmdDhaka() })
  const weekPhones = new Set(weekOrders.map((o) => normalizePhone(o.phone)).filter(Boolean))

  const newThisWeek = profiles
    .filter((p) => p.ordersCount === 1 && p.phone && weekPhones.has(normalizePhone(p.phone)!))
    .slice(0, 8)

  const notes: string[] = []
  const withoutClv = profiles.filter((p) => p.ordersCount >= 2 && !p.estimatedClv).length
  if (withoutClv > 0) {
    notes.push(
      `${withoutClv} জন repeat buyer-এর CLV হিসাব করা যায়নি — order amount+date phone match দরকার।`,
    )
  }

  const L: string[] = []
  L.push('🧠 *কাস্টমার লাইফটাইম ডাইজেস্ট*', '')

  if (topVips.length) {
    L.push(`👑 *VIP* (${profiles.filter((p) => p.tier === 'vip').length} জন):`)
    topVips.slice(0, 5).forEach((c) => {
      const clv = c.estimatedClv != null ? `, CLV ~৳${c.estimatedClv}` : ''
      L.push(`• ${c.name ?? c.phone ?? 'কাস্টমার'} — ${c.ordersCount}টি অর্ডার${clv}`)
      L.push(`  → ${c.engagementSuggestion}`)
    })
    L.push('')
  }

  if (highChurn.length) {
    L.push(`🚨 *High churn-risk* (${profiles.filter((p) => p.churnRisk === 'high' && p.ordersCount >= 2).length}):`)
    highChurn.slice(0, 5).forEach((c) => {
      L.push(`• ${c.name ?? c.phone ?? 'কাস্টমার'} — ${c.ordersCount}টি, ${c.daysSinceLast ?? '?'} দিন নেই`)
      L.push(`  → ${c.engagementSuggestion}`)
    })
    L.push('')
  }

  if (newThisWeek.length) {
    L.push(`🆕 *এই সপ্তাহে নতুন* (${newThisWeek.length}):`)
    newThisWeek.slice(0, 4).forEach((c) => {
      L.push(`• ${c.name ?? c.phone ?? 'কাস্টমার'} — ${c.engagementSuggestion}`)
    })
    L.push('')
  }

  if (notes.length) {
    L.push('ℹ️ ' + notes.join(' '))
  }

  return {
    vipCount: profiles.filter((p) => p.tier === 'vip').length,
    highChurnCount: profiles.filter((p) => p.churnRisk === 'high' && p.ordersCount >= 2).length,
    newThisWeekCount: newThisWeek.length,
    topVips,
    highChurn,
    newThisWeek,
    notes,
    formatted: L.join('\n'),
  }
}

export async function persistCustomerLifetimeKnowledge(): Promise<number> {
  const profiles = await buildCustomerProfiles()
  let count = 0

  const vips = profiles.filter((p) => p.tier === 'vip')
  if (vips.length) {
    const avgOrders = Math.round(vips.reduce((s, p) => s + p.ordersCount, 0) / vips.length)
    const withClv = vips.filter((p) => p.estimatedClv != null)
    const avgClv = withClv.length
      ? roundMoney(withClv.reduce((s, p) => s + (p.estimatedClv ?? 0), 0) / withClv.length)
      : null
    await learnFact({
      entityType: 'customer_segment',
      entityId: 'vip',
      entityName: 'VIP',
      attribute: 'lifetime_value',
      value: avgClv != null
        ? `${vips.length} VIP — গড় ${avgOrders} অর্ডার, est. CLV ~৳${avgClv}`
        : `${vips.length} VIP — গড় ${avgOrders} অর্ডার (CLV: order amount data কম)`,
      source: 'customer_lifetime',
      confidenceDelta: 0.08,
    })
    count++
  }

  const highChurn = profiles.filter((p) => p.churnRisk === 'high' && p.ordersCount >= 2)
  if (highChurn.length) {
    await learnFact({
      entityType: 'customer_segment',
      entityId: 'high_churn',
      entityName: 'High churn-risk',
      attribute: 'churn_risk',
      value: `${highChurn.length} জন repeat buyer উচ্চ churn-risk — win-back priority`,
      source: 'customer_lifetime',
      confidenceDelta: 0.1,
    })
    count++
  }

  return count
}
