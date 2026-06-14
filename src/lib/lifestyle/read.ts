import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import type { Order } from '@/types'
import {
  customerSummary,
  ordersSummaryFromSlice,
  prismaCustomerToGas,
  prismaOrderToGas,
  prismaProductToGas,
  prismaPromoToGas,
  prismaStockToGas,
  stockSummaryFromItems,
} from '@/lib/lifestyle/prisma-mappers'

type QueryParams = Record<string, string>

type ReadOrdersOpts = {
  includeItems?: boolean
  /** Metrics/dashboard need full filtered set, not paginated slice. */
  allMatching?: boolean
}

function buildOrderWhere(p: QueryParams): Prisma.LifestyleOrderWhereInput {
  const businessId = p.business_id || 'ALMA_LIFESTYLE'
  const where: Prisma.LifestyleOrderWhereInput = { businessId }
  if (p.startDate || p.endDate) {
    where.date = {}
    if (p.startDate) where.date.gte = new Date(p.startDate)
    if (p.endDate) where.date.lte = new Date(p.endDate)
  }
  if (p.status) where.status = p.status
  if (p.source) where.source = p.source
  if (p.payment) where.payment = p.payment
  return where
}

function applyOrderSearch(orders: Order[], search: string): Order[] {
  const q = search.toLowerCase()
  if (!q) return orders
  return orders.filter(o =>
    [o.id, o.customer, o.phone, o.product, o.tracking_id]
      .some(v => String(v).toLowerCase().includes(q)),
  )
}

async function readStockFromSupabase() {
  const rows = await prisma.lifestyleStockItem.findMany({
    where: { archived: false },
    orderBy: [{ sku: 'asc' }, { size: 'asc' }],
  })
  const items = rows.map(prismaStockToGas)
  return { items, summary: stockSummaryFromItems(items) }
}

async function readProductsFromSupabase() {
  const rows = await prisma.lifestyleProduct.findMany({
    where: { active: true },
    orderBy: { sku: 'asc' },
  })
  const products = rows.map(prismaProductToGas)
  return { products, total: products.length }
}

async function readCustomersFromSupabase(p: QueryParams) {
  const seg = p.segment || ''
  const risk = p.risk_level || ''
  const search = (p.search || '').toLowerCase()
  const rows = await prisma.lifestyleCustomer.findMany({
    where: { businessId: p.business_id || 'ALMA_LIFESTYLE' },
    orderBy: { id: 'asc' },
  })
  let customers = rows.map(prismaCustomerToGas)
  customers = customers.filter(c => {
    if (seg && c.segment !== seg) return false
    if (risk && c.risk_level !== risk) return false
    if (search) {
      return [c.name, c.phone, c.district].some(v => String(v).toLowerCase().includes(search))
    }
    return true
  })
  return { customers, summary: customerSummary(customers) }
}

async function readPromosFromSupabase() {
  const rows = await prisma.lifestylePromo.findMany({
    where: { businessId: 'ALMA_LIFESTYLE', active: true },
    orderBy: { code: 'asc' },
  })
  return { promos: rows.map(prismaPromoToGas) }
}

async function readOrdersFromSupabase(p: QueryParams, opts: ReadOrdersOpts = {}) {
  const includeItems = opts.includeItems === true
  const search = (p.search || '').toLowerCase()
  const limit = parseInt(p.limit || '500', 10)
  const offset = parseInt(p.offset || '0', 10)
  const where = buildOrderWhere(p)

  if (!search && !opts.allMatching) {
    const [rows, total] = await Promise.all([
      prisma.lifestyleOrder.findMany({
        where,
        include: includeItems ? { items: { orderBy: { lineNo: 'asc' } } } : undefined,
        orderBy: { date: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.lifestyleOrder.count({ where }),
    ])
    const orders = rows.map(row => prismaOrderToGas(includeItems ? row : { ...row, items: [] }))
    return { orders, summary: ordersSummaryFromSlice(orders), total }
  }

  const rows = await prisma.lifestyleOrder.findMany({
    where,
    include: includeItems ? { items: { orderBy: { lineNo: 'asc' } } } : undefined,
    orderBy: { date: 'desc' },
  })

  let orders: Order[] = rows.map(row => prismaOrderToGas(includeItems ? row : { ...row, items: [] }))
  orders = applyOrderSearch(orders, search)

  const total = orders.length
  const slice = opts.allMatching ? orders : orders.slice(offset, offset + limit)
  return { orders: slice, summary: ordersSummaryFromSlice(slice), total }
}

async function readOrderFromSupabase(id: string, p: QueryParams) {
  const row = await prisma.lifestyleOrder.findFirst({
    where: {
      id,
      businessId: p.business_id || 'ALMA_LIFESTYLE',
    },
    include: { items: { orderBy: { lineNo: 'asc' } } },
  })
  if (!row) return { error: `Order not found: ${id}` }
  return { order: prismaOrderToGas(row) }
}

/** Postgres-only lifestyle reads (Phase 4 — GAS fallback removed). */
export async function getLifestyleStock(_p: QueryParams = {}) {
  return readStockFromSupabase()
}

export async function getLifestyleProducts(_p: QueryParams = {}) {
  return readProductsFromSupabase()
}

export async function getLifestyleCustomers(p: QueryParams = {}) {
  return readCustomersFromSupabase(p)
}

export async function getLifestylePromos(_p: QueryParams = {}) {
  try {
    return await readPromosFromSupabase()
  } catch {
    return { promos: [] }
  }
}

export async function getLifestyleOrders(p: QueryParams = {}) {
  const data = await readOrdersFromSupabase(p, { includeItems: false })
  return {
    orders: data.orders,
    summary: { ...data.summary, total: data.total },
  }
}

export async function getLifestyleOrder(id: string, p: QueryParams = {}) {
  return readOrderFromSupabase(id, p)
}

export async function fetchOrderById(id: string, businessId = 'ALMA_LIFESTYLE'): Promise<Order | null> {
  const data = await getLifestyleOrder(id, { business_id: businessId })
  if ('error' in data && data.error) return null
  return data.order ?? null
}

/** All orders in range for dashboard/analytics — no line items (fast aggregate). */
export async function fetchLifestyleOrdersForMetrics(p: QueryParams = {}): Promise<Order[]> {
  const data = await readOrdersFromSupabase(
    { ...p, limit: String(p.limit || '10000'), offset: '0' },
    { includeItems: false, allMatching: true },
  )
  return data.orders
}
