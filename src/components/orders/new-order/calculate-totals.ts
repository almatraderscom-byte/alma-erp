import type { NewOrderForm, NewOrderItemForm } from './types'

export function orderItemSubtotal(item: NewOrderItemForm) {
  return Math.max(0, Number(item.qty || 0)) * Math.max(0, Number(item.sell_price || 0))
}

export function orderItemInventoryCost(item: NewOrderItemForm) {
  return Math.max(0, Number(item.qty || 0)) * Math.max(0, Number(item.cogs || 0))
}

export function orderItemGrossProfit(item: NewOrderItemForm) {
  return orderItemSubtotal(item) - orderItemInventoryCost(item)
}

/** Parse BDT fields stored as strings in the form (empty → 0). */
export function parseMoneyInput(value: string | undefined): number {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return 0
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : 0
}

export type NewOrderTotals = {
  subtotal: number
  discount: number
  shipping: number
  courierCost: number
  shippingMargin: number
  payable: number
  paid: number
  due: number
  totalQty: number
  inventoryCost: number
  estimatedProfit: number
}

/**
 * Customer pays shipping on top of merchandise (pass-through).
 * Profit = merchandise margin + (shipping collected − courier cost paid).
 */
export function calculateNewOrderTotals(form: NewOrderForm): NewOrderTotals {
  const subtotal = form.items.reduce((sum, item) => sum + orderItemSubtotal(item), 0)
  const discount = parseMoneyInput(form.discount)
  const shipping = parseMoneyInput(form.shipping_fee)
  const courierCost = parseMoneyInput(form.courier_charge)
  const paid = parseMoneyInput(form.paid_amount)

  const payable = Math.max(0, subtotal - discount + shipping)
  const paidClamped = Math.min(payable, Math.max(0, paid))
  const inventoryCost = form.items.reduce((sum, item) => sum + orderItemInventoryCost(item), 0)
  const merchandiseProfit = subtotal - discount - inventoryCost
  const shippingMargin = shipping - courierCost
  const estimatedProfit = merchandiseProfit + shippingMargin

  return {
    subtotal,
    discount,
    shipping,
    courierCost,
    shippingMargin,
    payable,
    paid: paidClamped,
    due: Math.max(0, payable - paidClamped),
    totalQty: form.items.reduce((sum, item) => sum + Number(item.qty || 0), 0),
    inventoryCost,
    estimatedProfit,
  }
}
