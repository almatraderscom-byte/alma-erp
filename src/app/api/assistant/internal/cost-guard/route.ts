/**
 * GET /api/assistant/internal/cost-guard — AI-spend budget guard (cost audit Phase 4).
 *
 * Agent-layer cron (imports agent libs, so it lives under /api/assistant/* per
 * the architecture rule — /api/cron/* is the ERP layer and may not import
 * @/agent/*). Wired as a Vercel cron in vercel.json.
 *
 * Every 30 minutes: compares today's + this month's tracked AI
 * spend (agent_cost_events, Dhaka calendar) against the owner's budgets
 * (cost.budget.dailyUsd / cost.budget.monthlyUsd — the same values the cost
 * dashboard edits). Crossing 80% or 100% of either budget sends the owner ONE
 * Telegram alert per level per day (KV-deduped), with the top spenders so the
 * owner immediately sees WHO is burning — the camera-listen incident class can
 * never again run silently all day.
 *
 * No budgets set → no-op. Read + notify only; never blocks or mutates spend.
 * Auth: Bearer CRON_SECRET, same as the other crons. Manual probe:
 * ?dry=1 computes and returns the verdict without sending or recording.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { getBudgetSettings } from '@/agent/lib/cost-events'
import { querySpendByProviderBetween } from '@/agent/lib/api-balances'
import { todayYmdDhaka, dhakaDayBounds } from '@/lib/agent-api/dhaka-date'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LEVELS = [
  { pct: 100, key: 'over', label: 'বাজেট পেরিয়ে গেছে' },
  { pct: 80, key: 'warn', label: 'বাজেটের ৮০% পেরিয়েছে' },
] as const

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

async function kvGet(key: string): Promise<string | null> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    return row?.value ?? null
  } catch {
    return null
  }
}

async function kvSet(key: string, value: string): Promise<void> {
  await prisma.agentKvSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

function topSpenders(byProvider: Record<string, number>, limit = 3): string {
  return Object.entries(byProvider)
    .filter(([, usd]) => usd > 0.001)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p, usd]) => `${p} ${fmtUsd(usd)}`)
    .join(' · ')
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return Response.json({ error: 'cron_secret_unset' }, { status: 503 })
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const dryRun = req.nextUrl.searchParams.get('dry') === '1'

  const budgets = await getBudgetSettings()
  if (budgets.dailyUsd == null && budgets.monthlyUsd == null) {
    return Response.json({ ok: true, skipped: 'no_budgets_set' })
  }

  const today = todayYmdDhaka()
  const { start: dayStart, end: dayEnd } = dhakaDayBounds(today)
  const monthStart = dhakaDayBounds(`${today.slice(0, 7)}-01`).start

  const [dayByProvider, monthByProvider] = await Promise.all([
    querySpendByProviderBetween(dayStart, dayEnd),
    querySpendByProviderBetween(monthStart, dayEnd),
  ])
  // Oxylabs bills prepaid credits, not USD — the dashboard excludes it from the
  // USD totals; the guard matches that definition of "spend".
  const sum = (m: Record<string, number>) =>
    Object.entries(m).reduce((s, [p, usd]) => (p === 'oxylabs' ? s : s + usd), 0)
  const dayUsd = sum(dayByProvider)
  const monthUsd = sum(monthByProvider)

  const scopes = [
    { scope: 'daily', spend: dayUsd, budget: budgets.dailyUsd, byProvider: dayByProvider, window: `আজ (${today})` },
    { scope: 'monthly', spend: monthUsd, budget: budgets.monthlyUsd, byProvider: monthByProvider, window: `এই মাস (${today.slice(0, 7)})` },
  ] as const

  const verdicts: Array<{ scope: string; spend: number; budget: number; level: string | null; alerted: boolean }> = []

  for (const s of scopes) {
    if (s.budget == null || s.budget <= 0) continue
    const pctUsed = (s.spend / s.budget) * 100
    const level = LEVELS.find((l) => pctUsed >= l.pct) ?? null
    let alerted = false
    if (level && !dryRun) {
      // One alert per scope+level per Dhaka day. The monthly 'over' state would
      // otherwise ping every 30 minutes for the rest of the month.
      const dedupKey = `cost_guard_alerted:${s.scope}:${level.key}:${today}`
      if (!(await kvGet(dedupKey))) {
        const msg =
          `⚠️ AI খরচ — ${level.label}\n\n` +
          `${s.window}: ${fmtUsd(s.spend)} / বাজেট ${fmtUsd(s.budget)} (${Math.round(pctUsed)}%)\n` +
          `বেশি খরচ: ${topSpenders(s.byProvider) || '—'}\n\n` +
          `বিস্তারিত: এজেন্ট অ্যাপ → AI খরচ ড্যাশবোর্ড। বাজেট বদলাতে সেখানেই সেট করুন, Boss।`
        const res = await sendOwnerText(msg)
        if (res.ok) {
          await kvSet(dedupKey, new Date().toISOString())
          alerted = true
        }
      }
    }
    verdicts.push({
      scope: s.scope,
      spend: Math.round(s.spend * 100) / 100,
      budget: s.budget,
      level: level?.key ?? null,
      alerted,
    })
  }

  return Response.json({ ok: true, dryRun, today, verdicts })
}
