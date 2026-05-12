export type OrderStatus =
  | 'Pending' | 'Confirmed' | 'Packed'
  | 'Shipped' | 'Delivered' | 'Returned' | 'Cancelled'

export type CustomerSegment = 'VIP' | 'REGULAR' | 'NEW' | 'RISKY' | 'BLACKLIST' | 'COLD'
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export interface Order {
  id: string; date: string; customer: string; phone: string; address: string
  payment: string; source: string; status: OrderStatus; product: string
  category: string; size: string; qty: number; unit_price: number
  discount: number; add_discount: number; adv_cost: number; adv_platform: string
  sell_price: number; shipping_fee: number; cogs: number; courier_charge: number
  other_costs: number; profit: number; courier: string; tracking_id: string
  tracking_status: string; est_delivery: string; actual_delivery: string
  return_reason: string; return_date: string; return_status: string; notes: string
  sku: string; handled_by: string; sla_status: string; days_pending: number
  days_in_transit: number; auto_flag: string; invoice_num: string; margin_pct: number
}

export interface Customer {
  id: string; name: string; phone: string; district: string; address: string
  whatsapp: string; total_orders: number; delivered: number; returned: number
  cancelled: number; pending: number; total_spent: number; avg_order: number
  total_profit: number; cod_orders: number; cod_fails: number; cod_fail_pct: number
  return_rate: number; last_order: string; days_inactive: number; fav_category: string
  clv_score: number; risk_score: number; risk_level: RiskLevel; segment: CustomerSegment
  loyalty_pts: number; source: string; wa_optin: string; notes: string
}

export interface StockItem {
  sku: string; product: string; category: string; color: string; size: string
  opening: number; purchased: number; sold: number; returned: number; damaged: number
  reserved: number; current_stock: number; available: number; reorder_level: number
  status: string; stock_value: number; sell_value: number; potential_profit: number
}

export interface DashboardKpis {
  total_orders: number; total_revenue: number; total_profit: number; total_cogs: number
  gross_margin: number; avg_order_value: number; delivered_count: number
  delivery_rate: number; return_rate: number; sla_breaches: number; pending_action: number
}

export interface DashboardData {
  kpis: DashboardKpis
  by_status: Record<string, number>
  by_source: Record<string, { orders: number; revenue: number }>
  by_payment: Record<string, number>
  by_category: Record<string, { orders: number; revenue: number; profit: number }>
  sla_breaches: Array<{ id: string; customer: string; sla_status: string; days_pending: number; days_in_transit: number }>
  recent_orders: Partial<Order>[]
  generated_at: string
}

export interface LogEvent {
  timestamp: string; type: string; reference: string; message: string; detail: string
}
