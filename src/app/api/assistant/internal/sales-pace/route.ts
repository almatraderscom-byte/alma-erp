/**
 * GET /api/assistant/internal/sales-pace
 * Intraday sales-pace snapshot for the VPS worker's sales-anomaly scheduler (#7).
 * Returns today's orders/revenue so far, plus a trailing-7-day daily baseline and
 * the current Dhaka hour, so the worker can flag an unusually slow (or hot) day.
 * Reuses the SAME safe order-read code path the agent already uses — no direct
 * live-ERP table queries from the worker.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getAgentOrdersSummary, listAgentOrders } from '@/lib/agent-api/orders.service'

export const runtime = 'nodejs'

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

function ymdDhaka(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const now = new Date()
    const dhakaHour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', hour12: false }).format(now),
    )

    // Today + yesterday via the canonical summary helper.
    const [today, yesterday] = await Promise.all([
      getAgentOrdersSummary('today'),
      getAgentOrdersSummary('yesterday'),
    ])

    // Trailing 7 full days (yesterday back 7) for a daily baseline.
    const end = new Date(now)
    end.setDate(end.getDate() - 1) // yesterday
    const start = new Date(end)
    start.setDate(start.getDate() - 6) // 7-day window
    const startYmd = ymdDhaka(start)
    const endYmd = ymdDhaka(end)

    let avg7Orders = 0
    let avg7Revenue = 0
    try {
      const { orders } = await listAgentOrders({ startDate: startYmd, endDate: endYmd, limit: 500 })
      // Group by Dhaka day to get per-day totals, then average over 7 days.
      const byDay: Record<string, { count: number; revenue: number }> = {}
      for (const o of orders) {
        const day = ymdDhaka(new Date(o.placedAt))
        if (day < startYmd || day > endYmd) continue
        byDay[day] = byDay[day] ?? { count: 0, revenue: 0 }
        byDay[day]!.count += 1
        byDay[day]!.revenue += o.totalAmount
      }
      const totalOrders = Object.values(byDay).reduce((s, d) => s + d.count, 0)
      const totalRevenue = Object.values(byDay).reduce((s, d) => s + d.revenue, 0)
      avg7Orders = Math.round((totalOrders / 7) * 10) / 10
      avg7Revenue = Math.round(totalRevenue / 7)
    } catch {
      /* baseline optional */
    }

    return NextResponse.json({
      todayYmd: ymdDhaka(now),
      dhakaHour,
      today: { orders: today.totalOrders, revenue: today.totalRevenue },
      yesterday: { orders: yesterday.totalOrders, revenue: yesterday.totalRevenue },
      avg7: { orders: avg7Orders, revenue: avg7Revenue },
      generatedAt: now.toISOString(),
    })
  } catch (err) {
    console.error('[sales-pace] internal API failed:', err)
    return NextResponse.json({ error: 'Failed to build sales pace' }, { status: 500 })
  }
}
