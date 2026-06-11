/**
 * GET /api/assistant/internal/cost-spend?period=today|month|both
 * Used by worker budget-check scheduler.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getBudgetSettings, sumCostUsdBetween } from '@/agent/lib/cost-events'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

function bounds() {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const dayStart = new Date(`${todayStr}T00:00:00+06:00`)
  const dayEnd = new Date(dayStart.getTime() + 86400000)
  const [y, m] = todayStr.split('-').map(Number)
  const monthStart = new Date(Date.UTC(y, m - 1, 1) - 6 * 60 * 60 * 1000)
  const monthEnd = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 6 * 60 * 60 * 1000)
  return { dayStart, dayEnd, monthStart, monthEnd }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const period = req.nextUrl.searchParams.get('period') ?? 'both'
  const { dayStart, dayEnd, monthStart, monthEnd } = bounds()
  const budgets = await getBudgetSettings()

  const result: Record<string, number | null> = {
    dailyBudgetUsd: budgets.dailyUsd,
    monthlyBudgetUsd: budgets.monthlyUsd,
    todayUsd: null,
    monthUsd: null,
  }

  if (period === 'today' || period === 'both') {
    result.todayUsd = await sumCostUsdBetween(dayStart, dayEnd)
  }
  if (period === 'month' || period === 'both') {
    result.monthUsd = await sumCostUsdBetween(monthStart, monthEnd)
  }

  return Response.json(result)
}
