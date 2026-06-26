import type { AlmaRole } from '@/lib/roles'

/**
 * Buying price and profit are owner/admin-only (owner decision 2026-06).
 * STAFF keeps the cost data because the order form needs per-unit COGS to record
 * an order's inventory cost — but the order UI hides profit/cost from STAFF on
 * screen. Pure browse roles (VIEWER, HR) get the cost fields stripped entirely.
 */
const COST_VISIBLE_ROLES: readonly AlmaRole[] = ['SUPER_ADMIN', 'ADMIN', 'STAFF']

export function canSeeProductCost(role: AlmaRole): boolean {
  return COST_VISIBLE_ROLES.includes(role)
}

export function redactStockCost<T extends { items: object[]; summary: object }>(data: T, role: AlmaRole): T {
  if (canSeeProductCost(role)) return data
  return {
    ...data,
    items: data.items.map(it => ({
      ...it,
      buyingPrice: undefined,
      stock_value: 0,
      sell_value: 0,
      potential_profit: 0,
    })),
    summary: { ...data.summary, total_value: 0 },
  }
}

export function redactProductCost<T extends { products: object[] }>(data: T, role: AlmaRole): T {
  if (canSeeProductCost(role)) return data
  return {
    ...data,
    products: data.products.map(p => ({ ...p, default_cogs: 0 })),
  }
}
