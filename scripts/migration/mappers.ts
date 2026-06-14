/** Map GAS JSON shapes → Prisma create/upsert payloads (whole-taka Int money). */

export function roundMoney(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n)
}

export function parseRequiredDate(value: unknown, fallback: string): Date {
  const s = String(value ?? '').trim()
  if (!s) return new Date(fallback)
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return new Date(fallback)
  return d
}

export function parseOptionalDate(value: unknown): Date | null {
  const s = String(value ?? '').trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function parseOptionalDateTime(value: unknown): Date | null {
  return parseOptionalDate(value)
}

export type GasOrder = {
  id?: string
  business_id?: string
  date?: string
  customer?: string
  phone?: string
  address?: string
  payment?: string
  source?: string
  status?: string
  product?: string
  category?: string
  size?: string
  qty?: number
  unit_price?: number
  discount?: number
  add_discount?: number
  adv_cost?: number
  adv_platform?: string
  sell_price?: number
  shipping_fee?: number
  cogs?: number
  courier_charge?: number
  other_costs?: number
  profit?: number
  courier?: string
  tracking_id?: string
  tracking_status?: string
  est_delivery?: string
  actual_delivery?: string
  return_reason?: string
  return_date?: string
  return_status?: string
  notes?: string
  sku?: string
  handled_by?: string
  invoice_num?: string
  auto_flag?: string
  paid_amount?: number
  due_amount?: number
  estimatedProfit?: number
  realizedProfit?: number
  reversedProfit?: number
  net_profit?: number
  return_net_profit?: number
  shipping_margin?: number
  merchandise_profit?: number
  returnType?: string
  courierCost?: number
  inventoryCost?: number
  stockRestored?: boolean
  stockRestoredAt?: string
  stockRestoreReason?: string
  items?: GasOrderItem[]
}

export type GasOrderItem = {
  line_no?: number
  sku?: string
  product_code?: string
  product?: string
  category?: string
  size?: string
  variant?: string
  qty?: number
  unit_price?: number
  sell_price?: number
  subtotal?: number
  cogs?: number
  stock_sku?: string
  collection_code?: string
  collection_type?: string
  size_group?: string
  variant_group?: string
}

export function mapGasOrder(o: GasOrder) {
  const id = String(o.id ?? '').trim()
  if (!id) throw new Error('empty order id')

  return {
    id,
    businessId: String(o.business_id || 'ALMA_LIFESTYLE'),
    date: parseRequiredDate(o.date, '2000-01-01'),
    customer: String(o.customer ?? ''),
    phone: String(o.phone ?? ''),
    address: String(o.address ?? ''),
    payment: String(o.payment ?? ''),
    source: String(o.source ?? ''),
    status: String(o.status ?? ''),
    product: String(o.product ?? ''),
    category: String(o.category ?? ''),
    size: String(o.size ?? ''),
    qty: roundMoney(o.qty ?? 1) || 1,
    unitPrice: roundMoney(o.unit_price),
    discount: roundMoney(o.discount),
    addDiscount: roundMoney(o.add_discount),
    advCost: roundMoney(o.adv_cost),
    advPlatform: String(o.adv_platform ?? ''),
    sellPrice: roundMoney(o.sell_price),
    shippingFee: roundMoney(o.shipping_fee),
    cogs: roundMoney(o.cogs),
    courierCharge: roundMoney(o.courier_charge),
    otherCosts: roundMoney(o.other_costs),
    profit: roundMoney(o.profit),
    courier: String(o.courier ?? ''),
    trackingId: String(o.tracking_id ?? ''),
    trackingStatus: String(o.tracking_status ?? ''),
    estDelivery: parseOptionalDate(o.est_delivery),
    actualDelivery: parseOptionalDate(o.actual_delivery),
    returnReason: String(o.return_reason ?? ''),
    returnDate: parseOptionalDate(o.return_date),
    returnStatus: String(o.return_status ?? ''),
    notes: String(o.notes ?? ''),
    sku: String(o.sku ?? ''),
    handledBy: String(o.handled_by ?? ''),
    invoiceNum: String(o.invoice_num ?? ''),
    autoFlag: String(o.auto_flag ?? ''),
    paidAmount: o.paid_amount != null ? roundMoney(o.paid_amount) : null,
    dueAmount: o.due_amount != null ? roundMoney(o.due_amount) : null,
    estimatedProfit: o.estimatedProfit != null ? roundMoney(o.estimatedProfit) : null,
    realizedProfit: o.realizedProfit != null ? roundMoney(o.realizedProfit) : null,
    reversedProfit: o.reversedProfit != null ? roundMoney(o.reversedProfit) : null,
    netProfit: o.net_profit != null ? roundMoney(o.net_profit) : null,
    returnNetProfit: o.return_net_profit != null ? roundMoney(o.return_net_profit) : null,
    shippingMargin: o.shipping_margin != null ? roundMoney(o.shipping_margin) : null,
    merchandiseProfit: o.merchandise_profit != null ? roundMoney(o.merchandise_profit) : null,
    returnType: o.returnType != null ? String(o.returnType) : null,
    courierCost: o.courierCost != null ? roundMoney(o.courierCost) : null,
    inventoryCost: o.inventoryCost != null ? roundMoney(o.inventoryCost) : null,
    stockRestored: o.stockRestored === true,
    stockRestoredAt: parseOptionalDateTime(o.stockRestoredAt),
    stockRestoreReason: o.stockRestoreReason != null ? String(o.stockRestoreReason) : null,
    notesMetaJson: o.items?.length ? JSON.stringify({ items: o.items }) : null,
  }
}

export function mapGasOrderItem(orderId: string, item: GasOrderItem, index: number) {
  const lineNo = roundMoney(item.line_no ?? index + 1) || index + 1
  return {
    orderId,
    lineNo,
    sku: String(item.sku ?? ''),
    productCode: String(item.product_code ?? ''),
    product: String(item.product ?? ''),
    category: String(item.category ?? ''),
    size: String(item.size ?? ''),
    variant: String(item.variant ?? ''),
    qty: roundMoney(item.qty ?? 1) || 1,
    unitPrice: roundMoney(item.unit_price),
    sellPrice: roundMoney(item.sell_price),
    subtotal: roundMoney(item.subtotal),
    cogs: roundMoney(item.cogs),
    stockSku: String(item.stock_sku ?? ''),
    collectionCode: String(item.collection_code ?? ''),
    collectionType: String(item.collection_type ?? ''),
    sizeGroup: String(item.size_group ?? ''),
    variantGroup: String(item.variant_group ?? ''),
  }
}

export type GasProduct = {
  id?: string
  sku?: string
  name?: string
  category?: string
  default_price?: number
  default_cogs?: number | null
  active?: boolean
  notes?: string
}

export function mapGasProduct(p: GasProduct) {
  const sku = String(p.sku || p.id || '').trim()
  const name = String(p.name ?? '').trim()
  if (!sku && !name) throw new Error('empty product sku/name')
  return {
    sku: sku || name,
    name: name || sku,
    category: String(p.category ?? ''),
    defaultCogs: roundMoney(p.default_cogs ?? 0),
    defaultPrice: roundMoney(p.default_price),
    active: p.active !== false,
    notes: String(p.notes ?? ''),
  }
}

export type GasStockItem = {
  sku?: string
  product?: string
  category?: string
  color?: string
  size?: string
  opening?: number
  purchased?: number
  sold?: number
  returned?: number
  damaged?: number
  reserved?: number
  current_stock?: number
  available?: number
  reorder_level?: number
  status?: string
  stock_value?: number
  sell_value?: number
  potential_profit?: number
  collectionCode?: string
  collectionType?: string
  sizeGroup?: string
  variantGroup?: string
  buyingPrice?: number
  barcode?: string
  archived?: boolean
  imageUrl?: string
  active?: boolean
}

export function mapGasStockItem(s: GasStockItem) {
  const sku = String(s.sku ?? '').trim()
  if (!sku) throw new Error('empty stock sku')
  const size = String(s.size ?? '')
  const meta = {
    collectionCode: s.collectionCode,
    collectionType: s.collectionType,
    sizeGroup: s.sizeGroup,
    variantGroup: s.variantGroup,
    buyingPrice: s.buyingPrice,
    barcode: s.barcode,
    archived: s.archived,
    imageUrl: s.imageUrl,
    active: s.active,
  }
  return {
    sku,
    size,
    product: String(s.product ?? ''),
    category: String(s.category ?? ''),
    color: String(s.color ?? ''),
    opening: roundMoney(s.opening),
    purchased: roundMoney(s.purchased),
    sold: roundMoney(s.sold),
    returned: roundMoney(s.returned),
    damaged: roundMoney(s.damaged),
    reserved: roundMoney(s.reserved),
    currentStock: roundMoney(s.current_stock),
    available: roundMoney(s.available),
    reorderLevel: roundMoney(s.reorder_level ?? 5) || 5,
    status: String(s.status ?? '').replace(/[✅⚠️❌]\s?/g, ''),
    stockValue: roundMoney(s.stock_value),
    sellValue: roundMoney(s.sell_value),
    potentialProfit: roundMoney(s.potential_profit),
    metaJson: JSON.stringify(meta),
    collectionCode: s.collectionCode != null ? String(s.collectionCode) : null,
    collectionType: s.collectionType != null ? String(s.collectionType) : null,
    sizeGroup: s.sizeGroup != null ? String(s.sizeGroup) : null,
    variantGroup: s.variantGroup != null ? String(s.variantGroup) : null,
    buyingPrice: s.buyingPrice != null ? roundMoney(s.buyingPrice) : null,
    barcode: s.barcode != null ? String(s.barcode) : '',
    archived: s.archived === true || String(s.status ?? '').toUpperCase() === 'ARCHIVED',
    imageUrl: s.imageUrl != null ? String(s.imageUrl) : null,
    active: s.active !== false && s.archived !== true,
  }
}

export type GasCustomer = {
  id?: string
  business_id?: string
  name?: string
  phone?: string
  district?: string
  address?: string
  whatsapp?: string
  total_orders?: number
  delivered?: number
  returned?: number
  cancelled?: number
  pending?: number
  total_spent?: number
  avg_order?: number
  total_profit?: number
  cod_orders?: number
  cod_fails?: number
  cod_fail_pct?: number
  return_rate?: number
  last_order?: string
  days_inactive?: number
  fav_category?: string
  clv_score?: number
  risk_score?: number
  risk_level?: string
  segment?: string
  loyalty_pts?: number
  source?: string
  wa_optin?: string
  notes?: string
}

export function mapGasCustomer(c: GasCustomer) {
  const id = String(c.id ?? '').trim()
  const phone = String(c.phone ?? '').trim()
  if (!id) throw new Error('empty customer id')
  if (!phone) throw new Error(`customer ${id}: empty phone`)
  return {
    id,
    businessId: String(c.business_id || 'ALMA_LIFESTYLE'),
    name: String(c.name ?? ''),
    phone,
    district: String(c.district ?? ''),
    address: String(c.address ?? ''),
    whatsapp: String(c.whatsapp ?? ''),
    totalOrders: roundMoney(c.total_orders),
    delivered: roundMoney(c.delivered),
    returned: roundMoney(c.returned),
    cancelled: roundMoney(c.cancelled),
    pending: roundMoney(c.pending),
    totalSpent: roundMoney(c.total_spent),
    avgOrder: roundMoney(c.avg_order),
    totalProfit: roundMoney(c.total_profit),
    codOrders: roundMoney(c.cod_orders),
    codFails: roundMoney(c.cod_fails),
    codFailPct: Number(c.cod_fail_pct ?? 0) || 0,
    returnRate: Number(c.return_rate ?? 0) || 0,
    lastOrder: parseOptionalDate(c.last_order),
    daysInactive: Number(c.days_inactive ?? 0) || 0,
    favCategory: String(c.fav_category ?? ''),
    clvScore: roundMoney(c.clv_score),
    riskScore: roundMoney(c.risk_score),
    riskLevel: String(c.risk_level || 'LOW'),
    segment: String(c.segment || 'NEW'),
    loyaltyPts: roundMoney(c.loyalty_pts),
    source: String(c.source ?? ''),
    waOptin: String(c.wa_optin ?? 'Yes'),
    notes: String(c.notes ?? ''),
  }
}
