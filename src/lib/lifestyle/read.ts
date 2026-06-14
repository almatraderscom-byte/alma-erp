import { prisma } from '@/lib/prisma'
import { isSupabaseReadEnabled } from '@/lib/migration-flags'
import { serverGet } from '@/lib/server-api'
import type { Prisma } from '@prisma/client'
import type { Customer, Order, StockItem } from '@/types'
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

async function readStockFromSupabase() {
  const rows = await prisma.lifestyleStockItem.findMany({ orderBy: [{ sku: 'asc' }, { size: 'asc' }] })
  const items = rows.map(prismaStockToGas)
  return { items, summary: stockSummaryFromItems(items) }
}

async function readProductsFromSupabase() {
  const rows = await prisma.lifestyleProduct.findMany({ orderBy: { sku: 'asc' } })
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
    where: { businessId: 'ALMA_LIFESTYLE' },
    orderBy: { code: 'asc' },
  })
  return { promos: rows.map(prismaPromoToGas) }
}

async function readOrdersFromSupabase(p: QueryParams) {
  const statusF = p.status || ''
  const sourceF = p.source || ''
  const paymentF = p.payment || ''
  const search = (p.search || '').toLowerCase()
  const limit = parseInt(p.limit || '500', 10)
  const offset = parseInt(p.offset || '0', 10)
  const businessId = p.business_id || 'ALMA_LIFESTYLE'

  const where: Prisma.LifestyleOrderWhereInput = { businessId }
  if (p.startDate || p.endDate) {
    where.date = {}
    if (p.startDate) where.date.gte = new Date(p.startDate)
    if (p.endDate) where.date.lte = new Date(p.endDate)
  }

  const rows = await prisma.lifestyleOrder.findMany({
    where,
    include: { items: { orderBy: { lineNo: 'asc' } } },
    orderBy: { date: 'desc' },
  })

  let orders: Order[] = rows.map(prismaOrderToGas)
  orders = orders.filter(o => {
    if (statusF && o.status !== statusF) return false
    if (sourceF && o.source !== sourceF) return false
    if (paymentF && o.payment !== paymentF) return false
    if (search) {
      return [o.id, o.customer, o.phone, o.product, o.tracking_id]
        .some(v => String(v).toLowerCase().includes(search))
    }
    return true
  })

  const total = orders.length
  const slice = orders.slice(offset, offset + limit)
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

export async function getLifestyleStock(p: QueryParams = {}) {
  if (await isSupabaseReadEnabled('stock')) return readStockFromSupabase()
  return serverGet<{ items?: StockItem[]; summary?: Record<string, number> }>('stock', p, 0)
}

export async function getLifestyleProducts(p: QueryParams = {}) {
  if (await isSupabaseReadEnabled('products')) return readProductsFromSupabase()
  return serverGet<{ products?: Array<Record<string, unknown>>; total?: number }>('products', p, 0)
}

export async function getLifestyleCustomers(p: QueryParams = {}) {
  if (await isSupabaseReadEnabled('customers')) return readCustomersFromSupabase(p)
  return serverGet<{ customers?: Customer[]; summary?: Record<string, unknown> }>('customers', p, 60)
}

export async function getLifestylePromos(p: QueryParams = {}) {
  if (await isSupabaseReadEnabled('promos')) {
    try {
      return await readPromosFromSupabase()
    } catch {
      return { promos: [] }
    }
  }
  try {
    return await serverGet<{ promos?: Array<Record<string, unknown>> }>('promos', p, 0)
  } catch {
    return { promos: [] }
  }
}

export async function getLifestyleOrders(p: QueryParams = {}) {
  if (await isSupabaseReadEnabled('orders')) {
    const data = await readOrdersFromSupabase(p)
    return {
      orders: data.orders,
      summary: { ...data.summary, total: data.total },
    }
  }
  return serverGet<{ orders?: Order[]; summary?: Record<string, unknown> }>('orders', p, 0)
}

export async function getLifestyleOrder(id: string, p: QueryParams = {}) {
  if (await isSupabaseReadEnabled('orders')) return readOrderFromSupabase(id, p)
  return serverGet<{ order?: Order; error?: string }>('order', { id, ...p }, 0)
}

/** Resolve order for routes that accept `{ order }` or bare Order. */
export async function fetchOrderById(id: string, businessId = 'ALMA_LIFESTYLE'): Promise<Order | null> {
  const data = await getLifestyleOrder(id, { business_id: businessId })
  if ('error' in data && data.error) return null
  return data.order ?? null
}
