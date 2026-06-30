import type {
  LifestyleCustomer,
  LifestyleExpense,
  LifestyleOrder,
  LifestyleOrderItem,
  LifestyleProduct,
  LifestylePromo,
  LifestyleStockItem,
} from '@prisma/client'
import { roundMoney } from '@/lib/money'
import type { Customer, Order, OrderItem, StockItem } from '@/types'
import type { ERPFinanceExpense, ERPFinanceResponse } from '@/types/hr'

function ymd(d: Date | null | undefined): string {
  if (!d) return ''
  return d.toISOString().slice(0, 10)
}

function daysBetween(from: Date, to = new Date()): number {
  const ms = to.getTime() - from.getTime()
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)))
}

function computeSlaFields(order: { status: string; date: Date; actualDelivery: Date | null }) {
  const status = String(order.status || '')
  const pendingStatuses = ['Pending', 'Confirmed', 'Packed']
  const daysPending = pendingStatuses.includes(status) ? daysBetween(order.date) : 0
  const daysInTransit = status === 'Shipped' ? daysBetween(order.date) : 0
  let slaStatus = ''
  if (pendingStatuses.includes(status) && daysPending > 2) slaStatus = 'SLA BREACH'
  else if (status === 'Shipped' && daysInTransit > 5) slaStatus = 'IN TRANSIT DELAY'
  return { days_pending: daysPending, days_in_transit: daysInTransit, sla_status: slaStatus }
}

export function prismaOrderToGas(
  row: LifestyleOrder & { items?: LifestyleOrderItem[] },
): Order {
  const sell = row.sellPrice
  const netProfit = row.netProfit ?? row.profit
  const sla = computeSlaFields(row)
  let items: OrderItem[] | undefined
  if (row.items?.length) {
    items = row.items.map(it => ({
      order_id: row.id,
      line_no: it.lineNo,
      sku: it.sku,
      product_code: it.productCode || undefined,
      product: it.product,
      category: it.category || undefined,
      size: it.size || undefined,
      variant: it.variant || undefined,
      qty: it.qty,
      unit_price: it.unitPrice,
      sell_price: it.sellPrice || undefined,
      subtotal: it.subtotal,
      cogs: it.cogs || undefined,
      stock_sku: it.stockSku || undefined,
      collection_code: it.collectionCode || undefined,
      collection_type: it.collectionType || undefined,
      size_group: it.sizeGroup || undefined,
      variant_group: it.variantGroup || undefined,
    }))
  }

  return {
    id: row.id,
    business_id: row.businessId,
    date: ymd(row.date),
    customer: row.customer,
    phone: row.phone,
    address: row.address,
    payment: row.payment,
    source: row.source,
    status: row.status as Order['status'],
    product: row.product,
    category: row.category,
    size: row.size,
    qty: row.qty,
    unit_price: row.unitPrice,
    discount: row.discount,
    add_discount: row.addDiscount,
    adv_cost: row.advCost,
    adv_platform: row.advPlatform,
    sell_price: sell,
    shipping_fee: row.shippingFee,
    cogs: row.cogs,
    courier_charge: row.courierCharge,
    other_costs: row.otherCosts,
    profit: row.profit,
    courier: row.courier,
    tracking_id: row.trackingId,
    tracking_status: row.trackingStatus,
    est_delivery: ymd(row.estDelivery),
    actual_delivery: ymd(row.actualDelivery),
    return_reason: row.returnReason,
    return_date: ymd(row.returnDate),
    return_status: row.returnStatus,
    notes: row.notes,
    sku: row.sku,
    handled_by: row.handledBy,
    invoice_num: row.invoiceNum,
    auto_flag: row.autoFlag,
    paid_amount: row.paidAmount ?? undefined,
    due_amount: row.dueAmount ?? undefined,
    estimatedProfit: row.estimatedProfit ?? undefined,
    realizedProfit: row.realizedProfit ?? undefined,
    reversedProfit: row.reversedProfit ?? undefined,
    net_profit: netProfit,
    return_net_profit: row.returnNetProfit ?? undefined,
    shipping_margin: row.shippingMargin ?? undefined,
    merchandise_profit: row.merchandiseProfit ?? undefined,
    returnType: row.returnType ?? undefined,
    courierCost: row.courierCost ?? undefined,
    inventoryCost: row.inventoryCost ?? undefined,
    stockRestored: row.stockRestored || undefined,
    stockRestoredAt: row.stockRestoredAt?.toISOString(),
    stockRestoreReason: row.stockRestoreReason ?? undefined,
    items,
    margin_pct: sell > 0 ? Math.round((netProfit / sell) * 100) : 0,
    ...sla,
  }
}

export function prismaStockToGas(row: LifestyleStockItem): StockItem {
  let meta: Record<string, unknown> = {}
  if (row.metaJson) {
    try { meta = JSON.parse(row.metaJson) as Record<string, unknown> } catch { /* ignore */ }
  }
  return {
    sku: row.sku,
    product: row.product,
    category: row.category,
    color: row.color,
    size: row.size,
    opening: row.opening,
    purchased: row.purchased,
    sold: row.sold,
    returned: row.returned,
    damaged: row.damaged,
    reserved: row.reserved,
    current_stock: row.currentStock,
    available: row.available,
    reorder_level: row.reorderLevel,
    status: row.status,
    stock_value: row.stockValue,
    sell_value: row.sellValue,
    potential_profit: row.potentialProfit,
    collectionCode: row.collectionCode ?? String(meta.collectionCode ?? ''),
    collectionType: row.collectionType ?? String(meta.collectionType ?? ''),
    sizeGroup: row.sizeGroup ?? String(meta.sizeGroup ?? ''),
    variantGroup: row.variantGroup ?? String(meta.variantGroup ?? ''),
    genderType: String(meta.genderType ?? meta.collectionType ?? ''),
    sizeCategory: String(meta.sizeCategory ?? meta.sizeGroup ?? ''),
    sizeValue: row.size,
    buyingPrice: row.buyingPrice ?? Number(meta.buyingPrice ?? 0),
    stockQty: row.available,
    barcode: row.barcode ?? '',
    active: row.active,
    archived: row.archived,
    imageUrl: row.imageUrl ?? String(meta.imageUrl ?? ''),
  }
}

export function prismaProductToGas(row: LifestyleProduct) {
  return {
    id: row.sku,
    sku: row.sku,
    name: row.name,
    category: row.category,
    default_price: row.defaultPrice,
    default_cogs: row.defaultCogs,
    active: row.active,
    notes: row.notes,
    updated_at: row.updatedAt.toISOString(),
  }
}

export function prismaExpenseToGas(row: LifestyleExpense): ERPFinanceExpense {
  const date = ymd(row.expenseDate)
  return {
    exp_id: row.legacySheetId || row.id,
    date,
    month: date.slice(0, 7),
    category: row.category,
    business_id: row.businessId,
    sub_cat: row.subCat ?? undefined,
    exp_type: row.expType ?? '',
    title: row.title ?? row.category,
    desc: row.description ?? undefined,
    vendor: row.vendor ?? undefined,
    amount: row.amount,
    payment_method: row.paymentMethod ?? undefined,
    payment_status: row.paymentStatus ?? undefined,
    receipt_ref: row.receiptRef ?? undefined,
    receipt_attachment_id: row.attachmentId ?? undefined,
    recurring: row.recurring,
    notes: row.notes ?? undefined,
  }
}

/** Build the GAS-compatible finance payload from Postgres expense rows (date desc). */
export function financeResponseFromExpenses(
  rows: LifestyleExpense[],
  cashBalance = 0,
): ERPFinanceResponse {
  const expenses = rows.map(prismaExpenseToGas)
  const byCategory: Record<string, number> = {}
  const byType: Record<string, number> = {}
  let total = 0
  for (const e of expenses) {
    total += e.amount
    byCategory[e.category || 'Uncategorized'] = (byCategory[e.category || 'Uncategorized'] ?? 0) + e.amount
    const t = e.exp_type || 'Other'
    byType[t] = (byType[t] ?? 0) + e.amount
  }
  return {
    total_expenses: roundMoney(total),
    cash_balance: roundMoney(cashBalance),
    by_category: byCategory,
    by_type: byType,
    expenses,
    recent_expenses: expenses.slice(0, 10),
  }
}

export function prismaCustomerToGas(row: LifestyleCustomer): Customer {
  return {
    id: row.id,
    business_id: row.businessId,
    name: row.name,
    phone: row.phone,
    district: row.district,
    address: row.address,
    whatsapp: row.whatsapp,
    total_orders: row.totalOrders,
    delivered: row.delivered,
    returned: row.returned,
    cancelled: row.cancelled,
    pending: row.pending,
    total_spent: row.totalSpent,
    avg_order: row.avgOrder,
    total_profit: row.totalProfit,
    cod_orders: row.codOrders,
    cod_fails: row.codFails,
    cod_fail_pct: row.codFailPct,
    return_rate: row.returnRate,
    last_order: ymd(row.lastOrder),
    days_inactive: row.daysInactive,
    fav_category: row.favCategory,
    clv_score: row.clvScore,
    risk_score: row.riskScore,
    risk_level: row.riskLevel as Customer['risk_level'],
    segment: row.segment as Customer['segment'],
    loyalty_pts: row.loyaltyPts,
    source: row.source,
    wa_optin: row.waOptin,
    notes: row.notes,
  }
}

export function prismaPromoToGas(row: LifestylePromo) {
  return {
    id: row.id,
    code: row.code,
    discount_pct: row.discountPct ?? undefined,
    discount_amount: row.discountAmount ?? undefined,
    active: row.active,
    expires_at: row.expiresAt?.toISOString() ?? undefined,
    usage_count: row.usageCount,
  }
}

export function stockSummaryFromItems(items: StockItem[]) {
  const active = items.filter(i => !i.archived && i.active !== false)
  const low = active.filter(i => {
    const avail = Number(i.available ?? i.current_stock ?? 0)
    const reorder = Number(i.reorder_level ?? 5)
    return avail > 0 && avail <= reorder
  }).length
  const out = active.filter(i => Number(i.available ?? i.current_stock ?? 0) <= 0).length
  return {
    total_skus: active.length,
    total_value: active.reduce((a, i) => a + Number(i.stock_value ?? 0), 0),
    total_sell_val: active.reduce((a, i) => a + Number(i.sell_value ?? 0), 0),
    low_stock: low,
    out_of_stock: out,
    archived: items.filter(i => i.archived).length,
  }
}

export function ordersSummaryFromSlice(orders: Order[]) {
  const byStatus: Record<string, number> = {}
  orders.forEach(o => {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1
  })
  return {
    total: orders.length,
    total_revenue: orders.reduce((a, o) => (String(o.status) === 'Delivered' ? a + o.sell_price : a), 0),
    total_profit: orders.reduce((a, o) => a + Number(o.realizedProfit || 0), 0),
    pending_profit: orders.reduce((a, o) => {
      const s = String(o.status)
      if (s !== 'Delivered' && s !== 'CANCELLED' && !s.startsWith('RETURNED')) {
        return a + Number(o.estimatedProfit ?? o.profit ?? 0)
      }
      return a
    }, 0),
    reversed_profit: orders.reduce((a, o) => a + Number(o.reversedProfit || 0), 0),
    by_status: byStatus,
  }
}

export function customerSummary(customers: Customer[]) {
  const bySegment: Record<string, number> = {}
  const byRisk: Record<string, number> = {}
  let clvSum = 0
  customers.forEach(c => {
    bySegment[c.segment] = (bySegment[c.segment] || 0) + 1
    byRisk[c.risk_level] = (byRisk[c.risk_level] || 0) + 1
    clvSum += c.clv_score
  })
  return {
    total: customers.length,
    by_segment: bySegment,
    by_risk: byRisk,
    total_revenue: customers.reduce((a, c) => a + c.total_spent, 0),
    avg_clv: customers.length ? Math.round(clvSum / customers.length) : 0,
  }
}

export { roundMoney }
