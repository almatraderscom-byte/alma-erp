/**
 * Phase 3 — Postgres-first lifestyle writes (source of truth when write flag is on).
 */
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { prismaOrderToGas } from '@/lib/lifestyle/prisma-mappers'
import type { Prisma } from '@prisma/client'

function num(value: unknown): number {
  return roundMoney(Number(value ?? 0))
}

function todayDate(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function computeStockStatus(current: number, reorder: number): string {
  if (current <= 0) return 'OUT OF STOCK'
  if (current <= reorder) return 'LOW STOCK'
  return 'IN STOCK'
}

function recalcOrderMoney(fields: {
  qty: number
  unitPrice: number
  discount: number
  addDiscount: number
  cogs: number
  courierCharge: number
  otherCosts: number
  advCost: number
}) {
  const sell = Math.max(0, fields.qty * fields.unitPrice - fields.discount - fields.addDiscount)
  const profit = sell - fields.cogs - fields.courierCharge - fields.otherCosts - fields.advCost
  return { sellPrice: roundMoney(sell), profit: roundMoney(profit) }
}

const TERMINAL_RESTORE = new Set(['CANCELLED', 'RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID'])

type OrderItemInput = {
  line_no: number
  product_code: string
  product: string
  category: string
  size: string
  variant: string
  qty: number
  unit_price: number
  sell_price: number
  subtotal: number
  sku: string
  stock_sku: string
  cogs: number
  collection_code: string
  collection_type: string
  size_group: string
  variant_group: string
}

function normalizeOrderItems(body: Record<string, unknown>): OrderItemInput[] {
  const raw = body.items
  if (!Array.isArray(raw) || !raw.length) return []
  return raw.map((item, i) => {
    const row = item as Record<string, unknown>
    const qty = num(row.qty)
    const unit = num(row.sell_price ?? row.unit_price)
    const sku = String(row.stock_sku ?? row.sku ?? row.product_code ?? '').trim()
    const product = String(row.product ?? row.product_name ?? '').trim()
    if (!product) throw new Error(`Item ${i + 1}: product is required`)
    if (!sku) throw new Error(`Item ${i + 1}: inventory SKU is required`)
    if (qty < 1) throw new Error(`Item ${i + 1}: qty must be at least 1`)
    if (unit <= 0) throw new Error(`Item ${i + 1}: selling price must be greater than 0`)
    return {
      line_no: num(row.line_no) || i + 1,
      product_code: String(row.product_code ?? sku),
      product,
      category: String(row.category ?? ''),
      size: String(row.size ?? ''),
      variant: String(row.variant ?? ''),
      qty,
      unit_price: unit,
      sell_price: unit,
      subtotal: num(row.subtotal ?? unit * qty),
      sku,
      stock_sku: sku,
      cogs: num(row.cogs),
      collection_code: String(row.collection_code ?? ''),
      collection_type: String(row.collection_type ?? ''),
      size_group: String(row.size_group ?? ''),
      variant_group: String(row.variant_group ?? ''),
    }
  })
}

function buildOrderNotesMeta(body: Record<string, unknown>, items: OrderItemInput[]) {
  const inventoryCost = items.length
    ? items.reduce((a, it) => a + it.cogs * it.qty, 0)
    : num(body.inventory_cost ?? body.cogs)
  const courierCost = num(body.courier_cost ?? body.courier_charge)
  const estimatedProfit = num(body.estimated_profit)
  const meta = {
    items_count: items.length || 1,
    paid_amount: num(body.paid_amount),
    due_amount: num(body.due_amount),
    estimatedProfit,
    realizedProfit: 0,
    reversedProfit: 0,
    courierCost,
    inventoryCost,
    accountingStatus: 'ESTIMATED',
    stockRestored: false,
    items,
  }
  const notes = String(body.notes ?? '')
  const suffix = 'ORDER_ITEMS_JSON:' + JSON.stringify(meta)
  return { notes: notes ? `${notes}\n${suffix}` : suffix, metaJson: JSON.stringify(meta), inventoryCost, courierCost, estimatedProfit }
}

export async function nextOrderId(): Promise<string> {
  const rows = await prisma.lifestyleOrder.findMany({
    where: { id: { startsWith: 'AL-' } },
    select: { id: true },
  })
  let max = 0
  for (const row of rows) {
    const n = parseInt(row.id.replace(/^AL-0*/, ''), 10)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return `AL-${String(max + 1).padStart(4, '0')}`
}

export async function nextCustomerId(): Promise<string> {
  const rows = await prisma.lifestyleCustomer.findMany({
    where: { id: { startsWith: 'CUST-' } },
    select: { id: true },
  })
  let max = 0
  for (const row of rows) {
    const n = parseInt(row.id.replace(/^CUST-0*/, ''), 10)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return `CUST-${String(max + 1).padStart(4, '0')}`
}

async function findStockBySku(sku: string, size = '') {
  const normalized = sku.trim()
  // The resolved stock SKU already encodes the size/variant pool (e.g. 133-KIDS,
  // 133-ADULT, 133T-ORNA). For MEN/WOMEN collections the order line's `size` is a
  // customer-facing value (numeric size, age band) that intentionally differs from
  // the stock row's `size` column, so an exact sku+size filter would miss the row.
  // Try the exact match first, then fall back to the SKU alone (effectively unique).
  if (size) {
    const exact = await prisma.lifestyleStockItem.findFirst({
      where: { sku: normalized, size },
      orderBy: { updatedAt: 'desc' },
    })
    if (exact) return exact
  }
  return prisma.lifestyleStockItem.findFirst({
    where: { sku: normalized },
    orderBy: { updatedAt: 'desc' },
  })
}

async function deductStockForItems(items: OrderItemInput[]) {
  for (const item of items) {
    const stock = await findStockBySku(item.stock_sku, item.size)
    if (!stock) throw new Error(`Inventory not found: ${item.stock_sku}`)
    const next = stock.currentStock - item.qty
    if (next < 0) throw new Error(`Insufficient stock for ${item.stock_sku}`)
    const available = Math.max(0, next - stock.reserved)
    const buying = stock.buyingPrice ?? 0
    await prisma.lifestyleStockItem.update({
      where: { id: stock.id },
      data: {
        currentStock: next,
        available,
        sold: stock.sold + item.qty,
        status: computeStockStatus(next, stock.reorderLevel),
        stockValue: buying * next,
      },
    })
  }
}

async function restoreStockForOrder(orderId: string, reason: string) {
  const order = await prisma.lifestyleOrder.findUnique({ where: { id: orderId } })
  if (!order || order.stockRestored) return
  const items = await prisma.lifestyleOrderItem.findMany({ where: { orderId } })
  for (const item of items) {
    const sku = item.stockSku || item.sku
    const stock = await findStockBySku(sku, item.size)
    if (!stock) continue
    const next = stock.currentStock + item.qty
    const available = Math.max(0, next - stock.reserved)
    const buying = stock.buyingPrice ?? 0
    await prisma.lifestyleStockItem.update({
      where: { id: stock.id },
      data: {
        currentStock: next,
        available,
        returned: stock.returned + item.qty,
        sold: Math.max(0, stock.sold - item.qty),
        status: computeStockStatus(next, stock.reorderLevel),
        stockValue: buying * next,
      },
    })
  }
  await prisma.lifestyleOrder.update({
    where: { id: orderId },
    data: { stockRestored: true, stockRestoredAt: new Date(), stockRestoreReason: reason },
  })
}

async function reapplyStockDeduction(orderId: string) {
  const order = await prisma.lifestyleOrder.findUnique({ where: { id: orderId } })
  if (!order?.stockRestored) return
  const items = await prisma.lifestyleOrderItem.findMany({ where: { orderId } })
  await deductStockForItems(items.map((it, i) => ({
    line_no: it.lineNo || i + 1,
    product_code: it.productCode,
    product: it.product,
    category: it.category,
    size: it.size,
    variant: it.variant,
    qty: it.qty,
    unit_price: it.unitPrice,
    sell_price: it.sellPrice,
    subtotal: it.subtotal,
    sku: it.sku,
    stock_sku: it.stockSku || it.sku,
    cogs: it.cogs,
    collection_code: it.collectionCode,
    collection_type: it.collectionType,
    size_group: it.sizeGroup,
    variant_group: it.variantGroup,
  })))
  await prisma.lifestyleOrder.update({
    where: { id: orderId },
    data: { stockRestored: false, stockRestoredAt: null, stockRestoreReason: null },
  })
}

export async function createOrderInPostgres(body: Record<string, unknown>) {
  const required = ['customer', 'phone', 'payment', 'source']
  for (const key of required) {
    if (!body[key] && body[key] !== 0) return { error: `Missing required field: ${key}` }
  }
  const items = normalizeOrderItems(body)
  if (!items.length && !body.product) return { error: 'Missing required field: product' }

  const businessId = String(body.business_id || 'ALMA_LIFESTYLE')
  const totalQty = items.length ? items.reduce((a, it) => a + it.qty, 0) : num(body.qty) || 1
  const subtotal = items.length
    ? items.reduce((a, it) => a + it.subtotal, 0)
    : num(body.unit_price) * totalQty
  const discount = num(body.discount)
  const addDiscount = num(body.add_discount)
  const { notes, metaJson, inventoryCost, courierCost, estimatedProfit } = buildOrderNotesMeta(body, items)
  const firstItem = items[0]
  const productSummary = firstItem
    ? firstItem.product + (items.length > 1 ? ` + ${items.length - 1} more` : '')
    : String(body.product ?? '').trim()
  const money = recalcOrderMoney({
    qty: totalQty,
    unitPrice: totalQty > 0 ? Math.round(subtotal / totalQty) : subtotal,
    discount,
    addDiscount,
    cogs: inventoryCost,
    courierCharge: courierCost,
    otherCosts: num(body.other_costs),
    advCost: num(body.adv_cost),
  })
  const profit = estimatedProfit || money.profit

  const orderId = await nextOrderId()
  await prisma.$transaction(async () => {
    if (items.length) await deductStockForItems(items)
    await prisma.lifestyleOrder.create({
      data: {
        id: orderId,
        businessId,
        date: todayDate(),
        customer: String(body.customer ?? '').trim(),
        phone: String(body.phone ?? '').trim(),
        address: String(body.address ?? ''),
        payment: String(body.payment ?? ''),
        source: String(body.source ?? ''),
        status: String(body.status ?? 'Pending'),
        product: productSummary,
        category: firstItem ? firstItem.category : String(body.category ?? ''),
        size: firstItem ? (firstItem.size || firstItem.variant) : String(body.size ?? ''),
        qty: totalQty,
        unitPrice: totalQty > 0 ? Math.round(subtotal / totalQty) : subtotal,
        discount,
        addDiscount,
        advCost: num(body.adv_cost),
        advPlatform: String(body.adv_platform ?? ''),
        sellPrice: money.sellPrice,
        shippingFee: num(body.shipping_fee),
        cogs: inventoryCost,
        courierCharge: courierCost,
        otherCosts: num(body.other_costs),
        profit,
        courier: String(body.courier ?? ''),
        trackingId: '',
        trackingStatus: 'Pending',
        notes,
        handledBy: String(body.handled_by ?? ''),
        estimatedProfit: profit,
        inventoryCost,
        courierCost,
        paidAmount: body.paid_amount != null ? num(body.paid_amount) : null,
        dueAmount: body.due_amount != null ? num(body.due_amount) : null,
        notesMetaJson: metaJson,
        items: items.length
          ? {
              create: items.map(it => ({
                lineNo: it.line_no,
                sku: it.sku,
                productCode: it.product_code,
                product: it.product,
                category: it.category,
                size: it.size,
                variant: it.variant,
                qty: it.qty,
                unitPrice: it.unit_price,
                sellPrice: it.sell_price,
                subtotal: it.subtotal,
                cogs: it.cogs,
                stockSku: it.stock_sku,
                collectionCode: it.collection_code,
                collectionType: it.collection_type,
                sizeGroup: it.size_group,
                variantGroup: it.variant_group,
              })),
            }
          : undefined,
      },
    })
  })

  return { ok: true, order_id: orderId, profit, items_count: items.length || 1 }
}

function normalizeStatus(status: string): string {
  const key = status.trim().toUpperCase().replace(/\s+/g, '_')
  if (key === 'CANCELLED' || key === 'CANCELED') return 'CANCELLED'
  if (key === 'FAILED_DELIVERY') return 'RETURNED_UNPAID'
  if (key === 'RETURNED_PAID') return 'RETURNED_PAID'
  if (key === 'RETURNED_UNPAID') return 'RETURNED_UNPAID'
  if (key === 'RETURNED') return 'RETURNED'
  if (key === 'PENDING') return 'Pending'
  if (key === 'CONFIRMED') return 'Confirmed'
  if (key === 'PACKED') return 'Packed'
  if (key === 'SHIPPED') return 'Shipped'
  if (key === 'DELIVERED') return 'Delivered'
  return status
}

export async function updateOrderStatusInPostgres(body: Record<string, unknown>) {
  const id = String(body.id ?? '')
  const status = normalizeStatus(String(body.status ?? ''))
  if (!id) return { error: 'id required' }
  if (!body.status) return { error: 'status required' }

  const order = await prisma.lifestyleOrder.findUnique({ where: { id } })
  if (!order) return { error: `Order not found: ${id}` }
  const oldStatus = order.status
  const oldKey = normalizeStatus(oldStatus)
  const reason = String(body.reason ?? '').slice(0, 500)

  if (TERMINAL_RESTORE.has(oldKey) && !TERMINAL_RESTORE.has(status) && order.stockRestored) {
    await reapplyStockDeduction(id)
  }

  const patch: Prisma.LifestyleOrderUpdateInput = { status }
  const now = todayDate()
  if (status === 'Shipped' && !order.actualDelivery) patch.estDelivery = now
  if (status === 'Delivered') patch.actualDelivery = now
  if (status === 'RETURNED' || status === 'RETURNED_PAID' || status === 'RETURNED_UNPAID') {
    patch.returnDate = now
    patch.returnStatus = status.replace(/_/g, ' ')
    patch.trackingStatus = status === 'RETURNED_PAID' ? 'Returned (paid delivery)' : status === 'RETURNED_UNPAID' ? 'Returned (refused)' : 'Returned'
    if (reason) patch.returnReason = reason
  }
  if (status === 'CANCELLED') {
    patch.trackingStatus = 'Cancelled'
    patch.returnStatus = 'Cancelled'
    if (reason) patch.returnReason = reason
  }

  await prisma.lifestyleOrder.update({ where: { id }, data: patch })
  if (TERMINAL_RESTORE.has(status)) await restoreStockForOrder(id, status)

  return { ok: true, order_id: id, old_status: oldStatus, new_status: status }
}

const GAS_FIELD_TO_PRISMA: Record<string, keyof Prisma.LifestyleOrderUpdateInput> = {
  CUSTOMER: 'customer',
  PHONE: 'phone',
  ADDRESS: 'address',
  PAYMENT: 'payment',
  SOURCE: 'source',
  STATUS: 'status',
  PRODUCT: 'product',
  CATEGORY: 'category',
  SIZE: 'size',
  QTY: 'qty',
  UNIT_PRICE: 'unitPrice',
  DISCOUNT: 'discount',
  ADD_DISCOUNT: 'addDiscount',
  ADV_COST: 'advCost',
  ADV_PLATFORM: 'advPlatform',
  SHIP_COLLECTED: 'shippingFee',
  COGS: 'cogs',
  COURIER_CHARGE: 'courierCharge',
  OTHER_COSTS: 'otherCosts',
  COURIER: 'courier',
  TRACKING_ID: 'trackingId',
  TRACKING_STATUS: 'trackingStatus',
  NOTES: 'notes',
  HANDLED_BY: 'handledBy',
  INVOICE_NUM: 'invoiceNum',
}

export async function updateOrderFieldInPostgres(body: Record<string, unknown>) {
  const id = String(body.id ?? '')
  const field = String(body.field ?? '').toUpperCase()
  if (!id) return { error: 'id required' }
  if (!field) return { error: 'field required' }
  if (body.value === undefined) return { error: 'value required' }

  const prismaField = GAS_FIELD_TO_PRISMA[field]
  if (!prismaField) return { error: `Unknown field: ${body.field}` }

  const order = await prisma.lifestyleOrder.findUnique({ where: { id } })
  if (!order) return { error: `Order not found: ${id}` }

  const patch: Prisma.LifestyleOrderUpdateInput = {}
  if (['qty', 'unitPrice', 'discount', 'addDiscount', 'cogs', 'courierCharge', 'otherCosts', 'advCost', 'shippingFee'].includes(prismaField as string)) {
    patch[prismaField] = num(body.value) as never
  } else {
    patch[prismaField] = String(body.value) as never
  }

  const merged = {
    qty: prismaField === 'qty' ? num(body.value) : order.qty,
    unitPrice: prismaField === 'unitPrice' ? num(body.value) : order.unitPrice,
    discount: prismaField === 'discount' ? num(body.value) : order.discount,
    addDiscount: prismaField === 'addDiscount' ? num(body.value) : order.addDiscount,
    cogs: prismaField === 'cogs' ? num(body.value) : order.cogs,
    courierCharge: prismaField === 'courierCharge' ? num(body.value) : order.courierCharge,
    otherCosts: prismaField === 'otherCosts' ? num(body.value) : order.otherCosts,
    advCost: prismaField === 'advCost' ? num(body.value) : order.advCost,
  }
  const money = recalcOrderMoney(merged)
  patch.sellPrice = money.sellPrice
  patch.profit = money.profit

  await prisma.lifestyleOrder.update({ where: { id }, data: patch })
  return { ok: true }
}

export async function updateOrderTrackingInPostgres(body: Record<string, unknown>) {
  const id = String(body.id ?? '')
  const trackingId = String(body.tracking_id ?? '')
  if (!id) return { error: 'id required' }
  if (!trackingId) return { error: 'tracking_id required' }

  const order = await prisma.lifestyleOrder.findUnique({ where: { id } })
  if (!order) return { error: `Order not found: ${id}` }

  const preShipped = ['Pending', 'Confirmed', 'Packed'].includes(order.status)
  const patch: Prisma.LifestyleOrderUpdateInput = {
    trackingId,
    courier: body.courier ? String(body.courier) : order.courier,
  }
  let autoShipped = false
  if (preShipped) {
    patch.status = 'Shipped'
    patch.trackingStatus = 'In Transit'
    const est = new Date()
    const addr = order.address.toLowerCase()
    est.setUTCDate(est.getUTCDate() + (addr.includes('dhaka') ? 3 : 5))
    patch.estDelivery = est
    autoShipped = true
  } else if (body.tracking_status) {
    patch.trackingStatus = String(body.tracking_status)
  }

  await prisma.lifestyleOrder.update({ where: { id }, data: patch })
  return { ok: true, order_id: id, tracking_id: trackingId, auto_shipped: autoShipped }
}

export async function createProductInPostgres(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim()
  if (!name) return { error: 'name required' }
  let sku = String(body.sku ?? '').trim()
  if (!sku) sku = `SKU-${Date.now()}`
  await prisma.lifestyleProduct.upsert({
    where: { sku },
    create: {
      sku,
      name,
      category: String(body.category ?? ''),
      defaultCogs: num(body.default_cogs ?? body.cogs),
      defaultPrice: num(body.default_price ?? body.price),
      active: body.active !== false,
      notes: String(body.notes ?? ''),
      imageUrl: body.image_url ? String(body.image_url) : null,
      supplier: String(body.supplier ?? 'manual'),
      supplierProductId: body.supplier_product_id ? String(body.supplier_product_id) : null,
      description: body.description ? String(body.description) : null,
      variantsJson: typeof body.variants_json === 'string' ? body.variants_json : null,
    },
    update: {
      name,
      category: String(body.category ?? ''),
      defaultCogs: num(body.default_cogs ?? body.cogs),
      defaultPrice: num(body.default_price ?? body.price),
      active: body.active !== false,
      notes: String(body.notes ?? ''),
    },
  })
  if (body.sync_to_stock !== false) {
    const existing = await findStockBySku(sku)
    if (!existing) {
      await prisma.lifestyleStockItem.create({
        data: {
          sku,
          product: name,
          category: String(body.category ?? ''),
          opening: 0,
          currentStock: 0,
          available: 0,
          reorderLevel: 5,
          status: 'OUT OF STOCK',
          buyingPrice: num(body.default_cogs ?? body.cogs),
        },
      })
    }
  }
  return { ok: true, product_id: sku }
}

export async function updateProductInPostgres(body: Record<string, unknown>) {
  const sku = String(body.sku ?? body.id ?? '').trim()
  if (!sku) return { error: 'sku required' }
  const existing = await prisma.lifestyleProduct.findUnique({ where: { sku } })
  if (!existing) return { error: `Product not found: ${sku}` }
  await prisma.lifestyleProduct.update({
    where: { sku },
    data: {
      name: body.name != null ? String(body.name) : undefined,
      category: body.category != null ? String(body.category) : undefined,
      defaultCogs: body.default_cogs != null || body.cogs != null ? num(body.default_cogs ?? body.cogs) : undefined,
      defaultPrice: body.default_price != null || body.price != null || body.sell_price != null
        ? num(body.default_price ?? body.price ?? body.sell_price)
        : undefined,
      active: body.active === false ? false : body.deactivate === true ? false : undefined,
      notes: body.notes != null ? String(body.notes) : undefined,
    },
  })
  return { ok: true, product_id: sku }
}

export async function createCustomerInPostgres(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim()
  const phone = String(body.phone ?? '').trim()
  if (!name || !phone) return { error: 'name and phone required' }
  const businessId = String(body.business_id || 'ALMA_LIFESTYLE')
  const existing = await prisma.lifestyleCustomer.findUnique({
    where: { businessId_phone: { businessId, phone } },
  })
  if (existing) return { ok: true, customer_id: existing.id, id: existing.id, profile_row: existing.id }
  const id = String(body.id ?? '').trim() || await nextCustomerId()
  await prisma.lifestyleCustomer.create({
    data: {
      id,
      businessId,
      name,
      phone,
      address: String(body.address ?? ''),
      district: String(body.district ?? ''),
      source: String(body.source ?? ''),
    },
  })
  return { ok: true, customer_id: id, id, profile_row: id }
}

export async function updateCustomerInPostgres(body: Record<string, unknown>) {
  const id = String(body.id ?? '')
  if (!id) return { error: 'id required' }
  const existing = await prisma.lifestyleCustomer.findUnique({ where: { id } })
  if (!existing) return { error: `Customer not found: ${id}` }
  let notes = existing.notes
  if (body.notes_append) notes = notes ? `${notes}\n${String(body.notes_append)}` : String(body.notes_append)
  else if (body.notes != null) notes = String(body.notes)
  await prisma.lifestyleCustomer.update({
    where: { id },
    data: {
      name: body.name != null ? String(body.name) : undefined,
      phone: body.phone != null ? String(body.phone) : undefined,
      address: body.address != null ? String(body.address) : undefined,
      district: body.district != null ? String(body.district) : undefined,
      source: body.source != null ? String(body.source) : undefined,
      notes,
    },
  })
  return { ok: true, customer_id: id }
}

export async function upsertPromoInPostgres(body: Record<string, unknown>, opts?: { deactivate?: boolean; delete?: boolean }) {
  const code = String(body.code ?? body.id ?? '').trim()
  if (!code) return { error: 'code required' }
  const businessId = String(body.business_id || 'ALMA_LIFESTYLE')
  if (opts?.delete) {
    await prisma.lifestylePromo.deleteMany({ where: { businessId, code } })
    return { ok: true, id: code, code }
  }
  const id = String(body.id ?? code)
  await prisma.lifestylePromo.upsert({
    where: { businessId_code: { businessId, code } },
    create: {
      id,
      businessId,
      code,
      discountPct: body.discount_pct != null ? num(body.discount_pct) : null,
      discountAmount: body.discount_amount != null ? num(body.discount_amount) : null,
      active: opts?.deactivate ? false : body.active !== false,
      expiresAt: body.expires_at ? new Date(String(body.expires_at)) : null,
      usageCount: num(body.usage_count),
    },
    update: {
      discountPct: body.discount_pct != null ? num(body.discount_pct) : undefined,
      discountAmount: body.discount_amount != null ? num(body.discount_amount) : undefined,
      active: opts?.deactivate ? false : body.active !== false,
      expiresAt: body.expires_at ? new Date(String(body.expires_at)) : undefined,
      usageCount: body.usage_count != null ? num(body.usage_count) : undefined,
    },
  })
  return { ok: true, id, code }
}

async function applyStockLevel(sku: string, newStock: number, buyingPrice?: number) {
  const stock = await findStockBySku(sku)
  if (!stock) return { error: `Inventory item not found: ${sku}` }
  const prev = stock.currentStock
  const next = Math.max(0, roundMoney(newStock))
  const buying = buyingPrice != null ? num(buyingPrice) : (stock.buyingPrice ?? 0)
  const available = Math.max(0, next - stock.reserved)
  await prisma.lifestyleStockItem.update({
    where: { id: stock.id },
    data: {
      currentStock: next,
      available,
      buyingPrice: buying,
      status: computeStockStatus(next, stock.reorderLevel),
      stockValue: buying * next,
    },
  })
  return { ok: true, sku, previous_stock: prev, new_stock: next, adjustment: next - prev }
}

export async function inventoryActionInPostgres(body: Record<string, unknown>) {
  const action = String(body.action ?? '')
  if (action === 'adjust') {
    if (Array.isArray(body.adjustments)) {
      const results = []
      for (const adj of body.adjustments as Array<{ sku: string; delta: number; reason?: string }>) {
        const stock = await findStockBySku(adj.sku)
        if (!stock) return { error: `Inventory item not found: ${adj.sku}` }
        results.push(await applyStockLevel(adj.sku, stock.currentStock + num(adj.delta)))
      }
      return { ok: true, results }
    }
    const sku = String(body.sku ?? '')
    if (!sku) return { error: 'sku required' }
    let newStock = body.new_stock
    if (newStock == null && body.delta != null) {
      const stock = await findStockBySku(sku)
      if (!stock) return { error: `Inventory item not found: ${sku}` }
      newStock = stock.currentStock + num(body.delta)
    }
    return applyStockLevel(sku, num(newStock), body.buying_price != null ? num(body.buying_price) : undefined)
  }
  if (action === 'bulk_update') {
    const items = (body.items ?? []) as Array<{ sku: string; new_stock: number; buying_price?: number }>
    const results = []
    for (const item of items) {
      results.push(await applyStockLevel(item.sku, num(item.new_stock), item.buying_price))
    }
    return { ok: true, results }
  }
  if (action === 'archive') {
    const sku = String(body.sku ?? '')
    const stock = await findStockBySku(sku)
    if (!stock) return { error: `Inventory item not found: ${sku}` }
    await prisma.lifestyleStockItem.update({
      where: { id: stock.id },
      data: { archived: true, active: false, status: 'ARCHIVED' },
    })
    return { ok: true, sku }
  }
  if (action === 'restore') {
    const sku = String(body.sku ?? '')
    const stock = await findStockBySku(sku)
    if (!stock) return { error: `Inventory item not found: ${sku}` }
    await prisma.lifestyleStockItem.update({
      where: { id: stock.id },
      data: { archived: false, active: true, status: computeStockStatus(stock.currentStock, stock.reorderLevel) },
    })
    return { ok: true, sku }
  }
  if (action === 'edit') {
    const sku = String(body.sku ?? '')
    const data = (body.data ?? {}) as Record<string, unknown>
    const stock = await findStockBySku(sku)
    if (!stock) return { error: `Inventory item not found: ${sku}` }
    await prisma.lifestyleStockItem.update({
      where: { id: stock.id },
      data: {
        product: data.product != null ? String(data.product) : undefined,
        category: data.category != null ? String(data.category) : undefined,
        color: data.color != null ? String(data.color) : undefined,
        size: data.sizeValue != null ? String(data.sizeValue) : data.size != null ? String(data.size) : undefined,
        reorderLevel: data.reorder_level != null ? num(data.reorder_level) : undefined,
        buyingPrice: data.buyingPrice != null ? num(data.buyingPrice) : undefined,
      },
    })
    return { ok: true, sku }
  }
  if (action === 'consolidate_lifestyle') {
    return { ok: true, dry_run: body.dry_run !== false, message: 'Postgres stock is already consolidated per sku+size' }
  }
  return { error: `Invalid inventory action: ${action}` }
}

export async function fetchOrderGasShape(id: string) {
  const row = await prisma.lifestyleOrder.findUnique({
    where: { id },
    include: { items: true },
  })
  if (!row) return null
  return prismaOrderToGas(row)
}

function crmDedupeKey(phone: string, name: string): string {
  const digits = String(phone || '').replace(/\D/g, '').slice(-11)
  if (digits.length >= 10) return `p:${digits}`
  const n = String(name || '').trim().toLowerCase()
  return n ? `n:${n}` : ''
}

/** Sync customer profiles from Postgres orders (replaces GAS admin_backfill_crm). */
export async function backfillCustomersFromOrdersInPostgres(businessId = 'ALMA_LIFESTYLE') {
  const [orders, customers] = await Promise.all([
    prisma.lifestyleOrder.findMany({
      where: { businessId },
      select: { customer: true, phone: true, address: true, source: true },
      orderBy: { date: 'asc' },
    }),
    prisma.lifestyleCustomer.findMany({
      where: { businessId },
      select: { phone: true, name: true },
    }),
  ])

  const existingKeys = new Set(customers.map(c => crmDedupeKey(c.phone, c.name)).filter(Boolean))
  const orderSeen = new Set<string>()
  let processed = 0
  let created = 0
  let skipped = 0
  let errors = 0

  for (const order of orders) {
    const name = String(order.customer || '').trim()
    const phone = String(order.phone || '').trim()
    if (!name && !phone) continue

    const key = crmDedupeKey(phone, name)
    if (!key) continue
    if (orderSeen.has(key)) {
      skipped += 1
      continue
    }
    orderSeen.add(key)

    const hadProfile = existingKeys.has(key)
    const result = await createCustomerInPostgres({
      name: name || phone,
      phone: phone || name,
      address: order.address || '',
      source: order.source || 'backfill',
      business_id: businessId,
    })
    if (result && typeof result === 'object' && 'error' in result && result.error) {
      errors += 1
      continue
    }
    processed += 1
    if (!hadProfile) {
      created += 1
      existingKeys.add(key)
    }
  }

  return { ok: true, processed, created, skipped, errors }
}
