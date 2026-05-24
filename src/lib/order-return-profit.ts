/**
 * Single source of truth for Alma order profit math (delivered + return scenarios).
 * GAS mirrors these formulas in WebApp_API.gs.js — keep in sync.
 */

export interface OrderProfitInputs {
  subtotal: number
  discount: number
  inventoryCost: number
  shippingFee: number
  courierCharge: number
}

export type OrderProfitScenario =
  | 'delivered'
  | 'returned_paid'
  | 'returned_unpaid'
  | 'cancelled'
  | 'in_progress'

export interface OrderProfitResult {
  merchandiseProfit: number
  shippingMargin: number
  netProfit: number
  scenario: OrderProfitScenario
}

export interface OrderAccountingSnapshot extends OrderProfitResult {
  realizedProfit: number
  reversedProfit: number
  pendingProfit: number
  returnNetProfit: number
}

function money(n: number): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.round(v)
}

function baseInputs(inputs: OrderProfitInputs) {
  return {
    subtotal: Math.max(0, money(inputs.subtotal)),
    discount: Math.max(0, money(inputs.discount)),
    inventoryCost: Math.max(0, money(inputs.inventoryCost)),
    shippingFee: Math.max(0, money(inputs.shippingFee)),
    courierCharge: Math.max(0, money(inputs.courierCharge)),
  }
}

export function calculateDeliveredProfit(inputs: OrderProfitInputs): OrderProfitResult {
  const i = baseInputs(inputs)
  const merchandiseProfit = i.subtotal - i.discount - i.inventoryCost
  const shippingMargin = i.shippingFee - i.courierCharge
  return {
    merchandiseProfit,
    shippingMargin,
    netProfit: merchandiseProfit + shippingMargin,
    scenario: 'delivered',
  }
}

export function calculateReturnedPaidProfit(inputs: OrderProfitInputs): OrderProfitResult {
  const i = baseInputs(inputs)
  const roundTripCourier = 2 * i.courierCharge
  return {
    merchandiseProfit: 0,
    shippingMargin: i.shippingFee - roundTripCourier,
    netProfit: i.shippingFee - roundTripCourier,
    scenario: 'returned_paid',
  }
}

export function calculateReturnedUnpaidProfit(inputs: OrderProfitInputs): OrderProfitResult {
  const i = baseInputs(inputs)
  const roundTripCourier = 2 * i.courierCharge
  return {
    merchandiseProfit: 0,
    shippingMargin: -roundTripCourier,
    netProfit: -roundTripCourier,
    scenario: 'returned_unpaid',
  }
}

export function calculateCancelledProfit(): OrderProfitResult {
  return {
    merchandiseProfit: 0,
    shippingMargin: 0,
    netProfit: 0,
    scenario: 'cancelled',
  }
}

function normalizeStatusKey(status: string): string {
  const key = String(status || '').trim().toUpperCase().replace(/\s+/g, '_')
  if (key === 'FAILED_DELIVERY') return 'RETURNED_UNPAID'
  return key
}

export function calculateOrderProfit(status: string, inputs: OrderProfitInputs): OrderProfitResult {
  const key = normalizeStatusKey(status)
  if (key === 'DELIVERED') return calculateDeliveredProfit(inputs)
  if (key === 'RETURNED_PAID') return calculateReturnedPaidProfit(inputs)
  if (key === 'RETURNED_UNPAID' || key === 'RETURNED') return calculateReturnedUnpaidProfit(inputs)
  if (key === 'CANCELLED' || key === 'CANCELED') return calculateCancelledProfit()
  const estimated = calculateDeliveredProfit(inputs)
  return { ...estimated, scenario: 'in_progress' }
}

export function calculateOrderAccounting(status: string, inputs: OrderProfitInputs): OrderAccountingSnapshot {
  const result = calculateOrderProfit(status, inputs)
  const key = normalizeStatusKey(status)

  if (key === 'DELIVERED') {
    return {
      ...result,
      realizedProfit: result.netProfit,
      reversedProfit: 0,
      pendingProfit: 0,
      returnNetProfit: 0,
    }
  }

  if (key === 'RETURNED_PAID' || key === 'RETURNED_UNPAID' || key === 'RETURNED') {
    const loss = result.netProfit < 0 ? Math.abs(result.netProfit) : 0
    return {
      ...result,
      realizedProfit: 0,
      reversedProfit: loss,
      pendingProfit: 0,
      returnNetProfit: result.netProfit,
    }
  }

  if (key === 'CANCELLED' || key === 'CANCELED') {
    return {
      ...result,
      realizedProfit: 0,
      reversedProfit: 0,
      pendingProfit: 0,
      returnNetProfit: 0,
    }
  }

  const pending = calculateDeliveredProfit(inputs).netProfit
  return {
    ...result,
    netProfit: pending,
    realizedProfit: 0,
    reversedProfit: 0,
    pendingProfit: pending,
    returnNetProfit: 0,
  }
}

/** Build profit inputs from a persisted order row (sheet / API). */
export function orderProfitInputsFromOrder(order: {
  unit_price?: number
  qty?: number
  discount?: number
  add_discount?: number
  sell_price?: number
  cogs?: number
  shipping_fee?: number
  courier_charge?: number
  inventoryCost?: number
}): OrderProfitInputs {
  const qty = Math.max(0, Number(order.qty || 0))
  const unitPrice = Math.max(0, Number(order.unit_price || 0))
  const subtotal = qty > 0 && unitPrice > 0 ? unitPrice * qty : Math.max(0, Number(order.sell_price || 0))
  return {
    subtotal,
    discount: Math.max(0, Number(order.discount || 0)) + Math.max(0, Number(order.add_discount || 0)),
    inventoryCost: Math.max(0, Number(order.inventoryCost ?? order.cogs ?? 0)),
    shippingFee: Math.max(0, Number(order.shipping_fee || 0)),
    courierCharge: Math.max(0, Number(order.courier_charge || 0)),
  }
}

export function projectedReturnLossBdt(
  status: 'RETURNED_PAID' | 'RETURNED_UNPAID',
  inputs: OrderProfitInputs,
): number {
  const result =
    status === 'RETURNED_PAID' ? calculateReturnedPaidProfit(inputs) : calculateReturnedUnpaidProfit(inputs)
  return result.netProfit < 0 ? Math.abs(result.netProfit) : 0
}
