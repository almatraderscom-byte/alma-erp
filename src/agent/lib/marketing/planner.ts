/**
 * Marketing month planner — extends File 03 strategist with a marketing lens.
 * Reuses advisor bundle, retail calendar, ads monitor metrics, playbook, creative angles.
 * Propose-only — owner approves before any creative/task orchestration.
 */
import { prisma } from '@/lib/prisma'
import { agentSmartText } from '@/agent/lib/llm-text'
import { buildAdvisorDataBundle } from '@/lib/advisor-data-bundle'
import { eventsInLeadWindow, upcomingEvents } from '@/agent/lib/retail-calendar'
import { fetchActiveCampaignMetrics } from '@/agent/lib/ads/insights'
import { getTopCreativeAngles } from '@/agent/lib/ads/creative-performance'
import { getActivePlaybook } from '@/agent/lib/playbook'
import { getInventoryWithSales } from '@/lib/inventory-with-sales'
import { sendOwnerApprovalCard } from '@/agent/lib/telegram-owner-notify'
import { todayYmdDhaka, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import type { BrandTheme } from '@/lib/content-engine/brand-identity'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type MarketingChannel = 'organic' | 'paid' | 'both'

export interface MarketingPlanItem {
  dateYmd: string
  channel: MarketingChannel
  productCode?: string
  theme: BrandTheme
  objective: string
  creativeBrief: string
  copyAngle?: string
}

const PLANNER_SYSTEM = `আপনি ALMA Lifestyle-এর marketing strategist (Dhaka Islamic modest fashion, COD/Messenger funnel)।
শুধু JSON array আউটপুট — markdown নয়।

প্রতিটি plan item:
{
  "dateYmd": "YYYY-MM-DD",
  "channel": "organic"|"paid"|"both",
  "productCode": "SKU or omit if general",
  "theme": "default"|"eid"|"puja"|"boishakh"|"winter",
  "objective": "Bangla — why this push now",
  "creativeBrief": "Bangla — feeds make_ad_creatives (visual + offer angle, garment fidelity)",
  "copyAngle": "optional Bangla hook for ad copy testing"
}

LOAD-BEARING RULES:
- Tie items to REAL upcoming calendar events, REAL stock/products in data, REAL ad/creative performance — demand invent করবেন না।
- Quiet period / thin data → fewer items or [] — daily busywork নিষিদ্ধ। Max 8 items for 4 weeks, max 4 for 2 weeks.
- High-leverage only: seasonal ramp, clear stale stock, scale winning angle, organic gap fill.
- correlation ≠ causation; assumptions স্পষ্ট।
- creativeBrief must be actionable for File 10 make_ad_creatives (product, theme, offer angle).
- Bangla objective/creativeBrief/copyAngle.
- Do NOT duplicate general cross-domain strategist moves (inventory reorder, staff issues) — marketing channel focus only.`

export async function gatherMarketingPlanContext(weeks = 2) {
  const today = todayYmdDhaka()
  const horizonEnd = addDaysYmd(today, weeks * 7)

  const [
    marketingBundle,
    productFocus,
    calendarUpcoming,
    calendarLead,
    campaignMetrics,
    topAngles,
    playbook,
    inventory,
  ] = await Promise.all([
    buildAdvisorDataBundle('marketing'),
    buildAdvisorDataBundle('product_focus'),
    Promise.resolve(upcomingEvents()),
    Promise.resolve(eventsInLeadWindow()),
    fetchActiveCampaignMetrics().catch(() => []),
    getTopCreativeAngles(5),
    getActivePlaybook('ALMA_LIFESTYLE'),
    getInventoryWithSales().catch(() => null),
  ])

  const stockHighlights = Array.isArray(inventory)
    ? inventory
        .filter((p: { currentStock?: number; unitsSold30d?: number }) =>
          (p.currentStock ?? 0) > 0 && (p.unitsSold30d ?? 0) >= 3,
        )
        .slice(0, 12)
        .map((p: { sku?: string; name?: string; currentStock?: number; unitsSold30d?: number }) => ({
          sku: p.sku,
          name: p.name,
          stock: p.currentStock,
          sales30d: p.unitsSold30d,
        }))
    : []

  const lowStock = Array.isArray(inventory)
    ? inventory
        .filter((p: { currentStock?: number; reorderLevel?: number }) =>
          (p.currentStock ?? 0) <= (p.reorderLevel ?? 0) && (p.currentStock ?? 0) > 0,
        )
        .slice(0, 8)
        .map((p: { sku?: string; name?: string; currentStock?: number }) => ({
          sku: p.sku,
          name: p.name,
          stock: p.currentStock,
        }))
    : []

  return {
    today,
    horizonEnd,
    weeks,
    marketingBundle,
    productFocus,
    calendar: {
      upcoming: calendarUpcoming.filter((e) => e.dateYmd <= horizonEnd),
      inLeadWindow: calendarLead,
    },
    ads: {
      campaigns: campaignMetrics.map((m) => ({
        name: m.name,
        spendWeek: Math.round(m.spendWeek),
        roasWeek: Number(m.roasWeek.toFixed(2)),
        ctrWeekPct: Number(m.ctrWeekPct.toFixed(2)),
        hasData: m.hasEnoughData,
      })),
    },
    winningAngles: topAngles,
    playbook: playbook.filter((p) => ['content', 'ads', 'customer'].includes(p.domain)),
    stockHighlights,
    lowStock,
  }
}

function parsePlanItems(raw: string, horizonEnd: string): MarketingPlanItem[] {
  const trimmed = raw.trim()
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []
  try {
    const arr = JSON.parse(jsonMatch[0]) as unknown[]
    if (!Array.isArray(arr)) return []
    const themes = new Set(['default', 'eid', 'puja', 'boishakh', 'winter'])
    const channels = new Set(['organic', 'paid', 'both'])
    const out: MarketingPlanItem[] = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const dateYmd = String(o.dateYmd ?? '').trim()
      const channel = String(o.channel ?? 'both')
      const objective = String(o.objective ?? '').trim()
      const creativeBrief = String(o.creativeBrief ?? '').trim()
      if (!dateYmd || !objective || !creativeBrief) continue
      if (dateYmd > horizonEnd) continue
      out.push({
        dateYmd,
        channel: channels.has(channel) ? (channel as MarketingChannel) : 'both',
        productCode: o.productCode ? String(o.productCode).trim() : undefined,
        theme: themes.has(String(o.theme)) ? (String(o.theme) as BrandTheme) : 'default',
        objective,
        creativeBrief,
        copyAngle: o.copyAngle ? String(o.copyAngle).trim() : undefined,
      })
    }
    return out
  } catch {
    return []
  }
}

export async function buildMarketingPlan(weeks = 2): Promise<{
  items: MarketingPlanItem[]
  context: Awaited<ReturnType<typeof gatherMarketingPlanContext>>
  thinData: boolean
}> {
  // Phase 42 gate: no campaign/content plan without an approved Growth Brief
  // (product availability, margin constraint, target customer, objective,
  // measurement plan, budget boundary). Owner-tunable: growth.brief.enforce.
  const { getPlanningAuthority } = await import('@/agent/lib/marketing/growth-brief')
  const authority = await getPlanningAuthority('ALMA_LIFESTYLE')
  if (!authority.allowed) {
    throw new Error(authority.ownerMessage ?? 'Approved growth brief required before planning.')
  }

  const context = await gatherMarketingPlanContext(weeks)
  const thinData =
    context.ads.campaigns.every((c) => !c.hasData) &&
    context.stockHighlights.length === 0 &&
    context.calendar.inLeadWindow.length === 0

  // Approved brief constraints ride along so the plan stays inside the owner's
  // budget boundary and speaks to the agreed objective/segments.
  const briefContent = authority.brief?.brief ?? null
  const briefForPrompt = briefContent
    ? {
        version: authority.brief!.version,
        objective: briefContent.objective,
        monthlyBudgetCapBdt: briefContent.economics?.monthlyBudgetCapBdt ?? null,
        targetCpaBdt: briefContent.economics?.targetCpaBdt ?? null,
        segments: (briefContent.customers?.segments ?? []).map((s) => s.name),
        focusProducts: (briefContent.products?.focus ?? []).map((p) => `${p.name} (${p.availability})`),
        measurementPlan: briefContent.measurementPlan,
      }
    : null

  // Anthropic-or-Gemini (owner: Gemini replaces Sonnet for now).
  const raw = await agentSmartText({
    system: PLANNER_SYSTEM,
    prompt:
      `Plan marketing for next ${weeks} week(s) (${context.today} → ${context.horizonEnd}).\n\n` +
      (briefForPrompt
        ? `Approved Growth Brief (v${briefForPrompt.version}) — plan MUST stay inside these boundaries:\n${JSON.stringify(briefForPrompt, null, 0)}\n\n`
        : '') +
      `Context JSON:\n${JSON.stringify(context, null, 0).slice(0, 12000)}\n\n` +
      'Output JSON array only.',
    maxTokens: 2400,
    costLabel: 'marketing_planner',
  })
  const items = parsePlanItems(raw, context.horizonEnd)

  return { items, context, thinData }
}

function formatPlanSummary(items: MarketingPlanItem[], weeks: number, thinData: boolean): string {
  const lines = [
    `📅 *Marketing Plan — ${weeks} সপ্তাহ (draft)*`,
    '',
    thinData
      ? '⚠️ _ডেটা পাতলা — সীমিত/high-leverage items only. Numbers directional._'
      : '_Calendar + stock + ad performance ভিত্তিক — correlation ≠ causation._',
    '',
  ]
  if (!items.length) {
    lines.push('এই সময়ে high-leverage marketing push নেই — [] (busywork avoid)।')
    return lines.join('\n')
  }
  items.forEach((it, i) => {
    lines.push(`*${i + 1}. ${it.dateYmd}* — ${it.channel.toUpperCase()} | theme: ${it.theme}`)
    if (it.productCode) lines.push(`   Product: ${it.productCode}`)
    lines.push(`   🎯 ${it.objective}`)
    lines.push(`   📝 Brief: ${it.creativeBrief.slice(0, 120)}${it.creativeBrief.length > 120 ? '…' : ''}`)
    if (it.copyAngle) lines.push(`   💬 Angle: ${it.copyAngle}`)
    lines.push('')
  })
  lines.push('Approve করলে paid → ad creative briefs, organic → staff tasks — auto-post/spend নয়।')
  return lines.join('\n')
}

export async function createMarketingPlanCard(opts: {
  weeks?: number
  conversationId?: string | null
}): Promise<{ pendingActionId: string; summary: string; itemCount: number; thinData: boolean }> {
  const weeks = Math.min(Math.max(opts.weeks ?? 2, 1), 4)
  const { items, thinData } = await buildMarketingPlan(weeks)
  const summary = formatPlanSummary(items, weeks, thinData)

  const action = await db.agentPendingAction.create({
    data: {
      conversationId: opts.conversationId ?? null,
      type: 'marketing_plan',
      payload: { items, weeks, thinData, conversationId: opts.conversationId ?? null },
      summary,
      costEstimate: 0,
      status: 'pending',
      businessId: 'ALMA_LIFESTYLE',
    },
  })

  await sendOwnerApprovalCard({
    summary,
    pendingActionId: action.id,
  }).catch(() => {})

  return {
    pendingActionId: action.id as string,
    summary,
    itemCount: items.length,
    thinData,
  }
}
