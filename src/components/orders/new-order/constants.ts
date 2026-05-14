import type { OrderStatus } from '@/types'

export const NEW_ORDER_STATUSES: OrderStatus[] = [
  'Pending', 'Confirmed', 'Packed', 'Shipped', 'Delivered', 'Returned', 'Cancelled',
]

export const CATEGORIES = ['Tops', 'Bottoms', 'Dresses', 'Kurtis', 'Outerwear', 'Sarees', 'Accessories', 'Other']
export const SOURCES = ['Facebook', 'WhatsApp', 'Instagram', 'Website', 'Walk-in', 'Referral']
export const COURIERS = ['Pathao', 'Redx', 'Steadfast', 'Paperfly', 'E-courier', 'Sundarban', 'SA Paribahan']
export const PAYMENTS = ['COD', 'bKash', 'Nagad', 'Rocket', 'Bank Transfer', 'Card']
