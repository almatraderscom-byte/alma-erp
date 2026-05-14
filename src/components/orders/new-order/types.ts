import type { OrderStatus } from '@/types'

export interface NewOrderForm {
  customer: string
  phone: string
  address: string
  product: string
  category: string
  size: string
  qty: string
  unit_price: string
  sell_price: string
  courier: string
  payment: string
  source: string
  status: OrderStatus
  notes: string
  sku: string
  cogs: string
  courier_charge: string
  shipping_fee: string
}

export type FormErrors = Partial<Record<keyof NewOrderForm, string>>
