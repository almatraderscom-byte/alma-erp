import { getLifestyleProducts, getLifestyleStock } from '@/lib/lifestyle/read'
import {
  mirrorAllStockAfterGasWrite,
  mirrorProductAfterGasWrite,
} from '@/lib/lifestyle/mirror'
import { serverPost } from '@/lib/server-api'
import { agentActorPayload } from '@/lib/agent-api/route-handler'
import type { StockItem } from '@/types'

type ProductsGasResponse = {
  products?: Array<Record<string, unknown>>
  items?: Array<Record<string, unknown>>
}

/** GAS products route — fields vary; map sku/product/name/price/stock from sheets. */
function mapProduct(raw: Record<string, unknown>, idx: number) {
  const sku = String(raw.sku ?? raw.SKU ?? raw.product_code ?? `sku_${idx}`)
  return {
    id: sku,
    name: String(raw.product ?? raw.name ?? raw.title ?? sku),
    category: String(raw.category ?? raw.CATEGORY ?? '') || null,
    price: Number(raw.sell_price ?? raw.price ?? raw.unit_price ?? 0),
    stock: Number(raw.current_stock ?? raw.stock ?? raw.stockQty ?? 0),
    sku,
    archived: Boolean(raw.archived ?? raw.active === false),
  }
}

export async function listProducts(input: { search?: string; category?: string; limit?: number }) {
  const data = await getLifestyleProducts()
  const rows = data.products ?? (Array.isArray(data) ? data : [])
  let products = (rows as Record<string, unknown>[]).map(mapProduct)
  if (input.search) {
    const q = input.search.toLowerCase()
    products = products.filter(p => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
  }
  if (input.category) products = products.filter(p => p.category === input.category)
  products = products.filter(p => !p.archived)
  const limit = input.limit ?? 100
  return { products: products.slice(0, limit), meta: { count: products.length } }
}

export async function getProduct(id: string) {
  const { products } = await listProducts({ limit: 500 })
  return products.find(p => p.id === id || p.sku === id) ?? null
}

export async function listLowStock() {
  const stock = await getLifestyleStock()
  const items = (stock.items ?? []).filter(
    i => Number(i.current_stock ?? i.stockQty ?? 0) <= Number(i.reorder_level ?? 5),
  )
  return {
    products: items.map((i, idx) => ({
      id: i.sku,
      name: i.product,
      sku: i.sku,
      stock: Number(i.current_stock ?? i.stockQty ?? 0),
      reorderLevel: Number(i.reorder_level ?? 0),
      status: i.status,
    })),
    meta: { count: items.length, lowStockSummary: stock.summary?.low_stock ?? items.length },
  }
}

export async function createProduct(body: Record<string, unknown>) {
  const result = await serverPost<{ product_id?: string; ok?: boolean }>(
    'create_product',
    agentActorPayload(body),
  )
  mirrorProductAfterGasWrite(String(result.product_id ?? body.sku ?? ''))
  return {
    id: String(result.product_id ?? body.sku ?? ''),
    status: 'created',
    createdAt: new Date().toISOString(),
  }
}

export async function patchProduct(id: string, body: Record<string, unknown>) {
  await serverPost('update_product', agentActorPayload({ sku: id, ...body }))
  mirrorProductAfterGasWrite(id)
  return { id, status: 'updated', updatedAt: new Date().toISOString() }
}

export async function patchProductPricing(id: string, price: number, note?: string) {
  await serverPost(
    'update_product',
    agentActorPayload({ sku: id, sell_price: price, price_note: note }),
  )
  mirrorProductAfterGasWrite(id)
  return { id, status: 'pricing_updated', price, updatedAt: new Date().toISOString() }
}

export async function patchProductInventory(id: string, delta: number, reason: string) {
  await serverPost(
    'inventory_adjust',
    agentActorPayload({ sku: id, delta, reason, action: 'adjust' }),
  )
  mirrorAllStockAfterGasWrite()
  return { id, status: 'inventory_adjusted', delta, updatedAt: new Date().toISOString() }
}

export async function softDeleteProduct(id: string) {
  await serverPost(
    'inventory_archive',
    agentActorPayload({ sku: id, action: 'archive' }),
  )
  mirrorAllStockAfterGasWrite()
  return { id, status: 'archived' }
}
