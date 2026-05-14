import type { NewOrderForm } from './types'

export const EMPTY_NEW_ORDER_FORM: NewOrderForm = {
  customer: '',
  phone: '',
  address: '',
  product: '',
  category: 'Tops',
  size: '',
  qty: '1',
  unit_price: '',
  sell_price: '',
  courier: 'Pathao',
  payment: 'COD',
  source: 'Facebook',
  status: 'Pending',
  notes: '',
  sku: '',
  cogs: '',
  courier_charge: '80',
  shipping_fee: '0',
}
