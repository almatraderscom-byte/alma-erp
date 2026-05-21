import type { NewOrderForm } from './types'

export const newOrderItem = (index = 0) => ({
  id: `item-${Date.now()}-${index}`,
  product_code: '',
  product: '',
  category: 'Tops',
  size: '',
  variant: '',
  qty: '1',
  sell_price: '',
  sku: '',
  cogs: '',
  available: undefined,
  collection_code: '',
  collection_type: undefined,
  size_group: '',
  variant_group: '',
  warning: '',
})

export const EMPTY_NEW_ORDER_FORM: NewOrderForm = {
  customer: '',
  phone: '',
  address: '',
  items: [newOrderItem(0)],
  courier: 'Pathao',
  payment: 'COD',
  source: 'Facebook',
  status: 'Pending',
  notes: '',
  courier_charge: '80',
  shipping_fee: '0',
  discount: '0',
  paid_amount: '0',
}
