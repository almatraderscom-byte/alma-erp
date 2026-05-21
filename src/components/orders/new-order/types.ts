import type { OrderStatus } from '@/types'

export interface NewOrderItemForm {
  id: string
  product_code: string
  product: string
  category: string
  size: string
  variant: string
  qty: string
  sell_price: string
  sku: string
  cogs: string
  available?: number
  collection_code?: string
  collection_type?: 'MEN' | 'WOMEN' | 'SINGLE' | 'CUSTOM'
  size_group?: string
  variant_group?: string
  warning?: string
}

export interface NewOrderForm {
  customer: string
  phone: string
  address: string
  items: NewOrderItemForm[]
  courier: string
  payment: string
  source: string
  status: OrderStatus
  notes: string
  courier_charge: string
  shipping_fee: string
  discount: string
  paid_amount: string
}

export type FormErrors = Partial<Record<keyof NewOrderForm | `item_${number}`, string>>
