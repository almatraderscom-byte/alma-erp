import type { FormErrors, NewOrderForm } from './types'

export function validateNewOrderForm(f: NewOrderForm): FormErrors {
  const e: FormErrors = {}
  if (!f.customer.trim()) e.customer = 'Customer name is required'
  if (!f.phone.trim()) e.phone = 'Phone is required'
  else if (!/^01[3-9]\d{8}$/.test(f.phone.replace(/\D/g, ''))) e.phone = 'Enter a valid BD number (e.g. 01711000000)'
  if (!f.product.trim()) e.product = 'Product name is required'
  if (!f.unit_price || Number(f.unit_price) <= 0) e.unit_price = 'Unit price must be > 0'
  if (!f.qty || Number(f.qty) <= 0) e.qty = 'Qty must be ≥ 1'
  if (!f.sell_price || Number(f.sell_price) <= 0) e.sell_price = 'Sell price must be > 0'
  return e
}
