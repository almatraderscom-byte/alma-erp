/**
 * Single source of truth for Alma order profit math (delivered + return scenarios).
 * GAS mirrors these formulas in WebApp_API.gs.js — keep in sync.
 */

import { roundMoney } from '@/lib/money'

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

function baseInputs(inputs: OrderProfitInputs) {
  return {
    subtotal: Math.max(0, roundMoney(inputs.subtotal)),
    discount: Math.max(0, roundMoney(inputs.discount)),
    inventoryCost: Math.max(0, roundMoney(inputs.inventoryCost)),
    shippingFee: Math.max(0, roundMoney(inputs.shippingFee)),
    courierCharge: Math.max(0, roundMoney(inputs.courierCharge)),
  }
}

function roundProfitResult(result: OrderProfitResult): OrderProfitResult {
  return {
    ...result,
    merchandiseProfit: roundMoney(result.merchandiseProfit),
    shippingMargin: roundMoney(result.shippingMargin),
    netProfit: roundMoney(result.netProfit),
  }
}

export function calculateDeliveredProfit(inputs: OrderProfitInputs): OrderProfitResult {
  const i = baseInputs(inputs)
  const merchandiseProfit = roundMoney(i.subtotal - i.discount - i.inventoryCost)
  const shippingMargin = roundMoney(i.shippingFee - i.courierCharge)
  return roundProfitResult({
    merchandiseProfit,
    shippingMargin,
    netProfit: roundMoney(merchandiseProfit + shippingMargin),
    scenario: 'delivered',
  })
}

export function calculateReturnedPaidProfit(inputs: OrderProfitInputs): OrderProfitResult {
  const i = baseInputs(inputs)
  const roundTripCourier = roundMoney(2 * i.courierCharge)
  const net = roundMoney(i.shippingFee - roundTripCourier)
  return roundProfitResult({
    merchandiseProfit: 0,
    shippingMargin: net,
    netProfit: net,
    scenario: 'returned_paid',
  })
}

export function calculateReturnedUnpaidProfit(inputs: OrderProfitInputs): OrderProfitResult {
  const i = baseInputs(inputs)
  const roundTripCourier = roundMoney(2 * i.courierCharge)
  return roundProfitResult({
    merchandiseProfit: 0,
    shippingMargin: roundMoney(-roundTripCourier),
    netProfit: roundMoney(-roundTripCourier),
    scenario: 'returned_unpaid',
  })
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

function roundAccounting(snapshot: OrderAccountingSnapshot): OrderAccountingSnapshot {
  return {
    ...snapshot,
    merchandiseProfit: roundMoney(snapshot.merchandiseProfit),
    shippingMargin: roundMoney(snapshot.shippingMargin),
    netProfit: roundMoney(snapshot.netProfit),
    realizedProfit: roundMoney(snapshot.realizedProfit),
    reversedProfit: roundMoney(snapshot.reversedProfit),
    pendingProfit: roundMoney(snapshot.pendingProfit),
    returnNetProfit: roundMoney(snapshot.returnNetProfit),
  }
}

export function calculateOrderAccounting(status: string, inputs: OrderProfitInputs): OrderAccountingSnapshot {
  const result = calculateOrderProfit(status, inputs)
  const key = normalizeStatusKey(status)

  if (key === 'DELIVERED') {
    return roundAccounting({
      ...result,
      realizedProfit: result.netProfit,
      reversedProfit: 0,
      pendingProfit: 0,
      returnNetProfit: 0,
    })
  }

  if (key === 'RETURNED_PAID' || key === 'RETURNED_UNPAID' || key === 'RETURNED') {
    const loss = result.netProfit < 0 ? roundMoney(Math.abs(result.netProfit)) : 0
    return roundAccounting({
      ...result,
      realizedProfit: 0,
      reversedProfit: loss,
      pendingProfit: 0,
      returnNetProfit: result.netProfit,
    })
  }

  if (key === 'CANCELLED' || key === 'CANCELED') {
    return roundAccounting({
      ...result,
      realizedProfit: 0,
      reversedProfit: 0,
      pendingProfit: 0,
      returnNetProfit: 0,
    })
  }

  const pending = calculateDeliveredProfit(inputs).netProfit
  return roundAccounting({
    ...result,
    netProfit: pending,
    realizedProfit: 0,
    reversedProfit: 0,
    pendingProfit: pending,
    returnNetProfit: 0,
  })
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
    subtotal: roundMoney(subtotal),
    discount: roundMoney(Math.max(0, Number(order.discount || 0)) + Math.max(0, Number(order.add_discount || 0))),
    inventoryCost: roundMoney(Math.max(0, Number(order.inventoryCost ?? order.cogs ?? 0))),
    shippingFee: roundMoney(Math.max(0, Number(order.shipping_fee || 0))),
    courierCharge: roundMoney(Math.max(0, Number(order.courier_charge || 0))),
  }
}

export function projectedReturnLossBdt(
  status: 'RETURNED_PAID' | 'RETURNED_UNPAID',
  inputs: OrderProfitInputs,
): number {
  const result =
    status === 'RETURNED_PAID' ? calculateReturnedPaidProfit(inputs) : calculateReturnedUnpaidProfit(inputs)
  return result.netProfit < 0 ? roundMoney(Math.abs(result.netProfit)) : 0
}
