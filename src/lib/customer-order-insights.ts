/**
 * CRM return insights derived from lifestyle orders (client-side).
 */
import { subDays, parseISO, isValid } from 'date-fns'
import { calculateOrderAccounting, orderProfitInputsFromOrder } from '@/lib/order-return-profit'
import { isTerminalReturnOrderStatus, normalizeOrderStatusKey } from '@/lib/order-analytics'
import type { Order } from '@/types'

export function normalizeCustomerPhone(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length >= 11) return digits.slice(-11)
  return digits
}

export function ordersForCustomer(orders: Order[], phone: string): Order[] {
  const key = normalizeCustomerPhone(phone)
  if (!key) return []
  return orders.filter(o => normalizeCustomerPhone(o.phone) === key)
}

export type CustomerReturnRisk = 'LOW' | 'MEDIUM' | 'HIGH'

export interface CustomerReturnInsights {
  totalOrders: number
  returnCount: number
  returnRatePct: number
  returnsLast30Days: number
  computedRisk: CustomerReturnRisk
  totalReturnLoss: number
  recentOrders: Array<{
    id: string
    date: string
    status: string
    sell_price: number
    returnLoss: number
    isReturn: boolean
  }>
}

export function buildCustomerReturnInsights(orders: Order[], phone: string, now = new Date()): CustomerReturnInsights {
  const customerOrders = ordersForCustomer(orders, phone)
  const totalOrders = customerOrders.length
  const cutoff = subDays(now, 30)

  let returnCount = 0
  let returnsLast30Days = 0
  let totalReturnLoss = 0

  for (const o of customerOrders) {
    const isReturn = isTerminalReturnOrderStatus(o.status)
    if (isReturn) {
      returnCount++
      const loss = Math.max(0, -Number(o.return_net_profit ?? calculateOrderAccounting(o.status, orderProfitInputsFromOrder(o)).returnNetProfit))
      totalReturnLoss += loss
      const d = o.date?.slice(0, 10)
      if (d) {
        const parsed = parseISO(d)
        if (isValid(parsed) && parsed >= cutoff) returnsLast30Days++
      }
    }
  }

  let computedRisk: CustomerReturnRisk = 'LOW'
  if (returnsLast30Days > 2) computedRisk = 'HIGH'
  else if (returnsLast30Days >= 1 || returnCount >= 2) computedRisk = 'MEDIUM'

  const recentOrders = [...customerOrders]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .map(o => {
      const isReturn = isTerminalReturnOrderStatus(o.status)
      const acct = calculateOrderAccounting(o.status, orderProfitInputsFromOrder(o))
      const returnNet = Number(o.return_net_profit ?? acct.returnNetProfit)
      return {
        id: o.id,
        date: o.date,
        status: normalizeOrderStatusKey(o.status),
        sell_price: o.sell_price,
        returnLoss: returnNet < 0 ? Math.abs(returnNet) : 0,
        isReturn,
      }
    })

  return {
    totalOrders,
    returnCount,
    returnRatePct: totalOrders > 0 ? Math.round(returnCount / totalOrders * 100) : 0,
    returnsLast30Days,
    computedRisk,
    totalReturnLoss,
    recentOrders,
  }
}
