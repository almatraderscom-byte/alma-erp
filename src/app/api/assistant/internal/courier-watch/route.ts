/**
 * GET /api/assistant/internal/courier-watch?slaDays=N
 * Delivery-SLA snapshot for the VPS worker's courier-watch scheduler (#10).
 * Flags orders that have been in a non-terminal state (placed/processing/shipped)
 * longer than the SLA window and are still not delivered/cancelled/returned.
 * Reuses the SAME safe order-read code path the agent uses — no direct live-ERP
 * table queries from the worker.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { listAgentOrders } from '@/lib/agent-api/orders.service'

export const runtime = 'nodejs'

// Terminal states that do NOT count as an SLA breach.
const TERMINAL = new Set(['delivered', 'cancelled', 'canceled', 'returned', 'refunded'])

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

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const slaDays = Math.min(Math.max(Number(req.nextUrl.searchParams.get('slaDays') ?? 4), 1), 30)
  const now = Date.now()
  const cutoffMs = now - slaDays * 86_400_000

  try {
    // Pull recent orders (auto-scoped to last 60 days by the service).
    const { orders } = await listAgentOrders({ limit: 500 })
    const breached = orders
      .filter((o) => !TERMINAL.has(String(o.status).toLowerCase()))
      .map((o) => {
        const placedMs = new Date(o.placedAt).getTime()
        const ageDays = Math.floor((now - placedMs) / 86_400_000)
        return {
          id: o.id,
          orderNumber: o.orderNumber ?? null,
          customerName: o.customerName,
          customerPhone: o.customerPhone,
          shippingCity: o.shippingCity ?? null,
          status: o.status,
          totalAmount: o.totalAmount,
          placedAt: o.placedAt,
          ageDays,
          placedMs,
        }
      })
      .filter((o) => o.placedMs <= cutoffMs)
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, 30)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ placedMs: _placedMs, ...rest }) => rest)

    return NextResponse.json({
      slaDays,
      breachedCount: breached.length,
      orders: breached,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[courier-watch] internal API failed:', err)
    return NextResponse.json({ error: 'Failed to build courier watch' }, { status: 500 })
  }
}
