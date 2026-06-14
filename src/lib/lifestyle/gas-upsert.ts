import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import type { Order, OrderItem } from '@/types'

function parseDate(value: unknown, fallback = '2000-01-01'): Date {
  const s = String(value ?? '').trim()
  if (!s) return new Date(fallback)
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? new Date(fallback) : d
}

function parseOptionalDate(value: unknown): Date | null {
  const s = String(value ?? '').trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function orderToPrismaPayload(o: Order) {
  const id = String(o.id ?? '').trim()
  if (!id) throw new Error('empty order id')
  return {
    id,
    businessId: String(o.business_id || 'ALMA_LIFESTYLE'),
    date: parseDate(o.date),
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
    stockRestoredAt: o.stockRestoredAt ? parseOptionalDate(o.stockRestoredAt) : null,
    stockRestoreReason: o.stockRestoreReason != null ? String(o.stockRestoreReason) : null,
    notesMetaJson: o.items?.length ? JSON.stringify({ items: o.items }) : null,
  }
}

function orderItemToPrisma(orderId: string, item: OrderItem, index: number) {
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
    sellPrice: roundMoney(Number(item.sell_price ?? 0)),
    subtotal: roundMoney(Number(item.subtotal ?? 0)),
    cogs: roundMoney(Number(item.cogs ?? 0)),
    stockSku: String(item.stock_sku ?? ''),
    collectionCode: String(item.collection_code ?? ''),
    collectionType: String(item.collection_type ?? ''),
    sizeGroup: String(item.size_group ?? ''),
    variantGroup: String(item.variant_group ?? ''),
  }
}

function num(value: unknown): number {
  return roundMoney(Number(value ?? 0))
}

export async function upsertOrderFromGas(order: Order): Promise<void> {
  const mapped = orderToPrismaPayload(order)
  await prisma.lifestyleOrder.upsert({
    where: { id: mapped.id },
    create: mapped,
    update: mapped,
  })
  await prisma.lifestyleOrderItem.deleteMany({ where: { orderId: mapped.id } })
  const items = order.items ?? []
  for (let i = 0; i < items.length; i++) {
    const itemData = orderItemToPrisma(mapped.id, items[i], i)
    await prisma.lifestyleOrderItem.create({ data: itemData })
  }
}

export async function upsertStockFromGasItem(item: Record<string, unknown>): Promise<void> {
  const sku = String(item.sku ?? '').trim()
  if (!sku) throw new Error('empty stock sku')
  const size = String(item.size ?? '')
  const meta = {
    collectionCode: item.collectionCode,
    collectionType: item.collectionType,
    sizeGroup: item.sizeGroup,
    variantGroup: item.variantGroup,
    buyingPrice: item.buyingPrice,
    barcode: item.barcode,
    archived: item.archived,
    imageUrl: item.imageUrl,
    active: item.active,
  }
  const data = {
    sku,
    size,
    product: String(item.product ?? ''),
    category: String(item.category ?? ''),
    color: String(item.color ?? ''),
    opening: num(item.opening),
    purchased: num(item.purchased),
    sold: num(item.sold),
    returned: num(item.returned),
    damaged: num(item.damaged),
    reserved: num(item.reserved),
    currentStock: num(item.current_stock),
    available: num(item.available),
    reorderLevel: num(item.reorder_level ?? 5) || 5,
    status: String(item.status ?? '').replace(/[✅⚠️❌]\s?/g, ''),
    stockValue: num(item.stock_value),
    sellValue: num(item.sell_value),
    potentialProfit: num(item.potential_profit),
    metaJson: JSON.stringify(meta),
    collectionCode: item.collectionCode != null ? String(item.collectionCode) : null,
    collectionType: item.collectionType != null ? String(item.collectionType) : null,
    sizeGroup: item.sizeGroup != null ? String(item.sizeGroup) : null,
    variantGroup: item.variantGroup != null ? String(item.variantGroup) : null,
    buyingPrice: item.buyingPrice != null ? num(item.buyingPrice) : null,
    barcode: item.barcode != null ? String(item.barcode) : '',
    archived: item.archived === true || String(item.status ?? '').toUpperCase() === 'ARCHIVED',
    imageUrl: item.imageUrl != null ? String(item.imageUrl) : null,
    active: item.active !== false && item.archived !== true,
  }
  await prisma.lifestyleStockItem.upsert({
    where: { sku_size: { sku, size } },
    create: data,
    update: data,
  })
}

export async function upsertProductFromGas(raw: Record<string, unknown>): Promise<void> {
  const sku = String(raw.sku ?? raw.id ?? '').trim()
  const name = String(raw.name ?? '').trim()
  if (!sku && !name) throw new Error('empty product')
  await prisma.lifestyleProduct.upsert({
    where: { sku: sku || name },
    create: {
      sku: sku || name,
      name: name || sku,
      category: String(raw.category ?? ''),
      defaultCogs: num(raw.default_cogs),
      defaultPrice: num(raw.default_price),
      active: raw.active !== false,
      notes: String(raw.notes ?? ''),
    },
    update: {
      name: name || sku,
      category: String(raw.category ?? ''),
      defaultCogs: num(raw.default_cogs),
      defaultPrice: num(raw.default_price),
      active: raw.active !== false,
      notes: String(raw.notes ?? ''),
    },
  })
}

export async function upsertCustomerFromGas(raw: Record<string, unknown>): Promise<void> {
  const id = String(raw.id ?? '').trim()
  const phone = String(raw.phone ?? '').trim()
  if (!id || !phone) throw new Error('invalid customer')
  const data = {
    id,
    businessId: String(raw.business_id || 'ALMA_LIFESTYLE'),
    name: String(raw.name ?? ''),
    phone,
    district: String(raw.district ?? ''),
    address: String(raw.address ?? ''),
    whatsapp: String(raw.whatsapp ?? ''),
    totalOrders: num(raw.total_orders),
    delivered: num(raw.delivered),
    returned: num(raw.returned),
    cancelled: num(raw.cancelled),
    pending: num(raw.pending),
    totalSpent: num(raw.total_spent),
    avgOrder: num(raw.avg_order),
    totalProfit: num(raw.total_profit),
    codOrders: num(raw.cod_orders),
    codFails: num(raw.cod_fails),
    codFailPct: Number(raw.cod_fail_pct ?? 0) || 0,
    returnRate: Number(raw.return_rate ?? 0) || 0,
    lastOrder: raw.last_order ? parseOptionalDate(raw.last_order) : null,
    daysInactive: Number(raw.days_inactive ?? 0) || 0,
    favCategory: String(raw.fav_category ?? ''),
    clvScore: num(raw.clv_score),
    riskScore: num(raw.risk_score),
    riskLevel: String(raw.risk_level || 'LOW'),
    segment: String(raw.segment || 'NEW'),
    loyaltyPts: num(raw.loyalty_pts),
    source: String(raw.source ?? ''),
    waOptin: String(raw.wa_optin ?? 'Yes'),
    notes: String(raw.notes ?? ''),
  }
  await prisma.lifestyleCustomer.upsert({
    where: { id },
    create: data,
    update: data,
  })
}
