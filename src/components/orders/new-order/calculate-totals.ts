import type { NewOrderForm, NewOrderItemForm } from './types'
import { calculateDeliveredProfit } from '@/lib/order-return-profit'
import { parseMoneyInput, roundMoney } from '@/lib/money'

export { parseMoneyInput } from '@/lib/money'

export function orderItemSubtotal(item: NewOrderItemForm) {
  return roundMoney(Math.max(0, Number(item.qty || 0)) * Math.max(0, Number(item.sell_price || 0)))
}

export function orderItemInventoryCost(item: NewOrderItemForm) {
  return roundMoney(Math.max(0, Number(item.qty || 0)) * Math.max(0, Number(item.cogs || 0)))
}

export function orderItemGrossProfit(item: NewOrderItemForm) {
  return roundMoney(orderItemSubtotal(item) - orderItemInventoryCost(item))
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
  const subtotal = roundMoney(form.items.reduce((sum, item) => sum + orderItemSubtotal(item), 0))
  const discount = parseMoneyInput(form.discount)
  const shipping = parseMoneyInput(form.shipping_fee)
  const courierCost = parseMoneyInput(form.courier_charge)
  const paid = parseMoneyInput(form.paid_amount)

  const payable = roundMoney(Math.max(0, subtotal - discount + shipping))
  const paidClamped = roundMoney(Math.min(payable, Math.max(0, paid)))
  const inventoryCost = roundMoney(form.items.reduce((sum, item) => sum + orderItemInventoryCost(item), 0))
  const delivered = calculateDeliveredProfit({
    subtotal,
    discount,
    inventoryCost,
    shippingFee: shipping,
    courierCharge: courierCost,
  })

  return {
    subtotal,
    discount,
    shipping,
    courierCost,
    shippingMargin: delivered.shippingMargin,
    payable,
    paid: paidClamped,
    due: roundMoney(Math.max(0, payable - paidClamped)),
    totalQty: form.items.reduce((sum, item) => sum + Number(item.qty || 0), 0),
    inventoryCost,
    estimatedProfit: delivered.netProfit,
  }
}
