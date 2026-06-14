/**
 * Merge inventory stock levels with order-based sell velocity (30d / 90d).
 */
import { getLifestyleOrders } from '@/lib/lifestyle/read'
import { listInventory } from '@/lib/agent-api/services/inventory.service'
import { todayYmdDhaka, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { expandOrderProductLines } from '@/lib/product-size-breakdown'
import { normalizeOrderStatusKey, filterOrdersByDateRange } from '@/lib/order-analytics'
import type { ForecastProductInput } from '@/lib/inventory-forecast'
import type { Order } from '@/types'

function countPiecesByProductKey(orders: Order[]): Record<string, number> {
  const byProduct: Record<string, number> = {}
  for (const o of orders) {
    if (normalizeOrderStatusKey(String(o.status)) === 'CANCELLED') continue
    const lines = expandOrderProductLines(o)
    for (const line of lines) {
      const key = line.code || 'Unknown'
      byProduct[key] = (byProduct[key] ?? 0) + line.qty
    }
  }
  return byProduct
}

async function fetchRecentOrders(): Promise<Order[]> {
  try {
    const raw = await getLifestyleOrders({ business_id: 'ALMA_LIFESTYLE', limit: '500' })
    return raw.orders ?? []
  } catch {
    return []
  }
}

function resolveSales(
  item: { sku: string; name: string },
  salesMap: Record<string, number>,
): number {
  if (salesMap[item.sku]) return salesMap[item.sku]
  if (salesMap[item.name]) return salesMap[item.name]
  const lowerName = item.name.toLowerCase()
  for (const [key, qty] of Object.entries(salesMap)) {
    if (key.toLowerCase() === lowerName) return qty
  }
  return 0
}

/** Inventory rows enriched with sales30d / sales90d from GAS order history. */
export async function getInventoryWithSales(): Promise<ForecastProductInput[]> {
  const today = todayYmdDhaka()
  const from30 = addDaysYmd(today, -30)
  const from90 = addDaysYmd(today, -90)

  const [inv, allOrders] = await Promise.all([
    listInventory().catch(() => ({ items: [] as Awaited<ReturnType<typeof listInventory>>['items'] })),
    fetchRecentOrders(),
  ])

  const orders30 = filterOrdersByDateRange(allOrders, { start: from30, end: today })
  const orders90 = filterOrdersByDateRange(allOrders, { start: from90, end: today })
  const sales30 = countPiecesByProductKey(orders30)
  const sales90 = countPiecesByProductKey(orders90)

  return inv.items.map((item) => ({
    id: item.sku,
    name: item.name,
    currentStock: item.currentStock,
    reorderLevel: item.reorderLevel ?? 0,
    sales30d: resolveSales(item, sales30),
    sales90d: resolveSales(item, sales90),
    tags: item.status ? [String(item.status).toLowerCase()] : [],
  }))
}
