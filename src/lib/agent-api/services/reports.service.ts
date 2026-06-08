import { serverGet } from '@/lib/server-api'
import { getAgentOrdersSummary, listAgentOrders } from '@/lib/agent-api/orders.service'
import { listInventory } from '@/lib/agent-api/services/inventory.service'
import { listCustomers } from '@/lib/agent-api/services/customers.service'
import { getAttendanceHistory, getAttendanceToday } from '@/lib/agent-api/services/attendance.service'
import { listTasks } from '@/lib/agent-api/services/tasks.service'
import { listFines } from '@/lib/agent-api/services/fines.service'
import type { SummaryPeriod } from '@/lib/agent-api/orders.schema'
import type { DashboardData } from '@/types'

export async function reportSales(period: SummaryPeriod, groupBy?: string) {
  const summary = await getAgentOrdersSummary(period)
  const { orders } = await listAgentOrders({ limit: 200 })
  const byCategory: Record<string, { orders: number; revenue: number }> = {}
  for (const o of orders) {
    const key = groupBy === 'product' ? (o.orderNumber ?? o.id) : 'general'
    if (!byCategory[key]) byCategory[key] = { orders: 0, revenue: 0 }
    byCategory[key].orders += 1
    byCategory[key].revenue += o.totalAmount
  }
  return { period, summary, byCategory, generatedAt: new Date().toISOString() }
}

export async function reportInventory(slowDays: number) {
  const inv = await listInventory()
  const slowMoving = inv.items.filter(i => i.currentStock > 0 && i.status?.includes('slow'))
  return {
    totalSkus: inv.meta.count,
    stockValueEstimate: inv.summary,
    slowMoving,
    slowDays,
    generatedAt: new Date().toISOString(),
  }
}

export async function reportCustomers(period: string, top: number) {
  const { customers } = await listCustomers({ limit: 500 })
  const sorted = [...customers].sort((a, b) => b.totalSpent - a.totalSpent)
  return {
    period,
    topBuyers: sorted.slice(0, top),
    newVsReturning: {
      new: customers.filter(c => c.totalOrders <= 1).length,
      returning: customers.filter(c => c.totalOrders > 1).length,
    },
    generatedAt: new Date().toISOString(),
  }
}

export async function reportEmployees(days: number) {
  const today = await getAttendanceToday()
  const tasks = await listTasks({ limit: 100 })
  const fines = await listFines({ limit: 100 })
  return {
    days,
    attendanceToday: today,
    pendingTasks: tasks.meta.count,
    pendingFines: fines.fines.filter(f => f.awaitingApproval).length,
    generatedAt: new Date().toISOString(),
  }
}

export async function reportFinance(period: string) {
  const dash = await serverGet<DashboardData>('dashboard', {}, 0)
  const finance = await serverGet<{ total_expenses?: number; cash_balance?: number }>('finance', {}, 0)
  return {
    period,
    revenue: dash.kpis?.total_revenue ?? 0,
    profit: dash.kpis?.total_profit ?? 0,
    expenses: finance.total_expenses ?? dash.total_expenses ?? 0,
    cashBalance: finance.cash_balance ?? dash.cash_balance ?? 0,
    generatedAt: new Date().toISOString(),
  }
}
