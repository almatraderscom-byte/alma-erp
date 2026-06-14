/**
 * Return root-cause analysis — reads raw GAS orders (not mapped AgentOrder).
 */
import { serverGet } from '@/lib/server-api'
import { todayYmdDhaka, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import {
  filterOrdersByDateRange,
  isTerminalReturnOrderStatus,
  normalizeOrderStatusKey,
} from '@/lib/order-analytics'
import { expandOrderProductLines } from '@/lib/product-size-breakdown'
import { roundMoney } from '@/lib/money'
import type { Order } from '@/types'

export interface ReturnInsight {
  totalReturns: number
  returnRatePct: number | null
  byProduct: Array<{ product: string; count: number; ratePct?: number }>
  byReason: Array<{ reason: string; count: number }>
  revenueImpact: { paid: number; unpaid: number }
  flags: string[]
  windowDays: number
}

async function fetchGasOrders(): Promise<Order[]> {
  try {
    const raw = await serverGet<{ orders?: Order[] }>(
      'orders',
      { business_id: 'ALMA_LIFESTYLE', limit: '500' },
      0,
    )
    return raw.orders ?? []
  } catch {
    return []
  }
}

function returnReasonLabel(order: Order): string {
  const reason = String(order.return_reason ?? order.returnType ?? '').trim()
  if (reason) return reason
  const notes = String(order.notes ?? '').trim()
  if (notes && /return|ফেরত|রিটার্ন/i.test(notes)) return notes.slice(0, 80)
  return 'কারণ অজানা'
}

function isPaidReturn(status: string): boolean {
  return normalizeOrderStatusKey(status) === 'RETURNED_PAID'
}

export async function analyzeReturns(opts: { days?: number } = {}): Promise<ReturnInsight> {
  const days = opts.days ?? 30
  const today = todayYmdDhaka()
  const fromYmd = addDaysYmd(today, -days)

  const allFetched = await fetchGasOrders()
  const inWindow = filterOrdersByDateRange(allFetched, { start: fromYmd, end: today })
  const returns = inWindow.filter((o) => isTerminalReturnOrderStatus(String(o.status)))

  const total = returns.length
  const orderTotal = inWindow.length
  const returnRatePct =
    orderTotal > 0 ? Math.round((total / orderTotal) * 1000) / 10 : null

  const productMap = new Map<string, number>()
  const productDeliveredMap = new Map<string, number>()
  const reasonMap = new Map<string, number>()
  let paidImpact = 0
  let unpaidImpact = 0

  for (const o of inWindow) {
    const statusKey = normalizeOrderStatusKey(String(o.status))
    const lines = expandOrderProductLines(o)
    for (const line of lines) {
      const key = line.code || 'Unknown'
      if (isTerminalReturnOrderStatus(String(o.status))) {
        productMap.set(key, (productMap.get(key) ?? 0) + line.qty)
      } else if (statusKey === 'DELIVERED') {
        productDeliveredMap.set(key, (productDeliveredMap.get(key) ?? 0) + line.qty)
      }
    }
  }

  for (const r of returns) {
    const reason = returnReasonLabel(r)
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1)
    const amt = roundMoney(Number(r.sell_price ?? r.paid_amount ?? 0))
    if (isPaidReturn(String(r.status))) paidImpact += amt
    else unpaidImpact += amt
  }

  const byProduct = [...productMap.entries()]
    .map(([product, count]) => {
      const delivered = productDeliveredMap.get(product) ?? 0
      const ratePct =
        delivered + count > 0 ? Math.round((count / (delivered + count)) * 1000) / 10 : undefined
      return { product, count, ratePct }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  const byReason = [...reasonMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)

  const flags: string[] = []
  if (returnRatePct != null && returnRatePct > 15) {
    flags.push(`Return rate ${returnRatePct}% — গড়ের চেয়ে বেশি`)
  }
  if (byProduct[0] && byProduct[0].count >= 3) {
    flags.push(`${byProduct[0].product} সবচেয়ে বেশি ফেরত (${byProduct[0].count}টি)`)
  }
  if (byReason[0] && byReason[0].count >= 3 && byReason[0].reason !== 'কারণ অজানা') {
    flags.push(`সাধারণ কারণ: ${byReason[0].reason} (${byReason[0].count}টি)`)
  }

  return {
    totalReturns: total,
    returnRatePct,
    byProduct,
    byReason,
    revenueImpact: { paid: paidImpact, unpaid: unpaidImpact },
    flags,
    windowDays: days,
  }
}

/** Lightweight flags-only payload for morning briefing. */
export async function analyzeReturnFlags(days = 30): Promise<Pick<ReturnInsight, 'flags' | 'totalReturns' | 'returnRatePct'>> {
  const full = await analyzeReturns({ days })
  return {
    flags: full.flags,
    totalReturns: full.totalReturns,
    returnRatePct: full.returnRatePct,
  }
}
