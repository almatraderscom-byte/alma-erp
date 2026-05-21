import type { FormErrors, NewOrderForm } from './types'

export function validateNewOrderForm(f: NewOrderForm): FormErrors {
  const e: FormErrors = {}
  if (!f.customer.trim()) e.customer = 'Customer name is required'
  if (!f.phone.trim()) e.phone = 'Phone is required'
  else if (!/^01[3-9]\d{8}$/.test(f.phone.replace(/\D/g, ''))) e.phone = 'Enter a valid BD number (e.g. 01711000000)'
  if (!f.items.length) e.items = 'Add at least one item'
  f.items.forEach((item, index) => {
    if (item.collection_type === 'MEN' && !item.size.trim()) e[`item_${index}`] = 'Select a valid size for this collection'
    else if (item.collection_type === 'WOMEN' && !item.variant.trim()) e[`item_${index}`] = 'Select a valid women variant'
    else if (!item.product.trim()) e[`item_${index}`] = 'Product is required'
    else if (!item.sku.trim()) e[`item_${index}`] = 'Connect item to inventory SKU'
    else if (!item.qty || Number(item.qty) <= 0) e[`item_${index}`] = 'Qty must be ≥ 1'
    else if (item.available != null && Number(item.qty) > Number(item.available)) e[`item_${index}`] = `Only ${item.available} available`
    else if (!item.sell_price || Number(item.sell_price) <= 0) e[`item_${index}`] = 'Selling price must be > 0'
  })
  if (Number(f.discount || 0) < 0) e.discount = 'Discount cannot be negative'
  if (Number(f.shipping_fee || 0) < 0) e.shipping_fee = 'Shipping cannot be negative'
  if (Number(f.paid_amount || 0) < 0) e.paid_amount = 'Paid amount cannot be negative'
  return e
}
