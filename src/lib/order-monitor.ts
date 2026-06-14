import { listAgentOrders } from '@/lib/agent-api/orders.service'
import type { AgentOrder } from '@/lib/agent-api/orders.schema'
import { daysAgoYmd, todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

export interface OrderIssue {
  type: 'stuck_pending' | 'pile_up' | 'high_cancel' | 'high_return' | 'mismatch'
  severity: 'high' | 'normal'
  detail: string
  count?: number
  orders?: string[]
}

const MS_PER_DAY = 86_400_000
const STUCK_PENDING_DAYS = 3
const PILE_UP_THRESHOLD = 15
const CANCEL_RATE_THRESHOLD = 0.2
const RETURN_RATE_THRESHOLD = 0.15
const MIN_RECENT_FOR_RATES = 10

function orderRef(order: AgentOrder): string {
  return order.orderNumber?.trim() || order.id
}

export async function detectOrderIssues(): Promise<OrderIssue[]> {
  const issues: OrderIssue[] = []
  const now = Date.now()
  const weekStart = daysAgoYmd(6)
  const today = todayYmdDhaka()

  const [pending, recent, cancelled, returned] = await Promise.all([
    listAgentOrders({ status: 'pending', limit: 100 }),
    listAgentOrders({ startDate: weekStart, endDate: today, limit: 100 }),
    listAgentOrders({ status: 'cancelled', startDate: weekStart, endDate: today, limit: 100 }),
    listAgentOrders({ status: 'refunded', startDate: weekStart, endDate: today, limit: 100 }),
  ])

  const stuck = (pending.orders ?? []).filter((order) => {
    const placed = new Date(order.placedAt).getTime()
    return Number.isFinite(placed) && placed > 0 && now - placed > STUCK_PENDING_DAYS * MS_PER_DAY
  })
  if (stuck.length > 0) {
    issues.push({
      type: 'stuck_pending',
      severity: stuck.length >= 5 ? 'high' : 'normal',
      detail: `${stuck.length}টি অর্ডার ${STUCK_PENDING_DAYS}+ দিন ধরে pending — confirm/deliver হয়নি`,
      count: stuck.length,
      orders: stuck.slice(0, 10).map(orderRef),
    })
  }

  const pendingCount = pending.meta?.count ?? pending.orders?.length ?? 0
  if (pendingCount >= PILE_UP_THRESHOLD) {
    issues.push({
      type: 'pile_up',
      severity: 'high',
      detail: `${pendingCount}টি pending অর্ডার জমে আছে`,
      count: pendingCount,
    })
  }

  const recentCount = recent.meta?.count ?? recent.orders?.length ?? 0
  const cancelCount = cancelled.meta?.count ?? cancelled.orders?.length ?? 0
  if (recentCount >= MIN_RECENT_FOR_RATES && cancelCount / recentCount > CANCEL_RATE_THRESHOLD) {
    issues.push({
      type: 'high_cancel',
      severity: 'high',
      detail: `এই সপ্তাহে cancel rate ${Math.round((cancelCount / recentCount) * 100)}% — স্বাভাবিকের চেয়ে বেশি`,
      count: cancelCount,
    })
  }

  const returnCount = returned.meta?.count ?? returned.orders?.length ?? 0
  if (recentCount >= MIN_RECENT_FOR_RATES && returnCount / recentCount > RETURN_RATE_THRESHOLD) {
    issues.push({
      type: 'high_return',
      severity: 'normal',
      detail: `Return rate ${Math.round((returnCount / recentCount) * 100)}% — কারণ দেখা দরকার (analyze_returns দিয়ে)`,
      count: returnCount,
    })
  }

  const mismatchPending = (pending.orders ?? []).filter(
    (order) =>
      order.totalAmount > 0
      && (!order.paymentMethod || !String(order.paymentMethod).trim()),
  )
  if (mismatchPending.length >= 3) {
    issues.push({
      type: 'mismatch',
      severity: 'normal',
      detail: `${mismatchPending.length}টি pending অর্ডারে payment method খালি — verify করুন`,
      count: mismatchPending.length,
      orders: mismatchPending.slice(0, 8).map(orderRef),
    })
  }

  return issues
}
