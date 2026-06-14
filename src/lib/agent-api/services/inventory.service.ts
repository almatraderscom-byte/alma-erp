import { getLifestyleStock } from '@/lib/lifestyle/read'
import { mirrorAllStockAfterGasWrite } from '@/lib/lifestyle/mirror'
import { serverGet, serverPost } from '@/lib/server-api'
import { agentActorPayload } from '@/lib/agent-api/route-handler'
import type { StockItem } from '@/types'

export async function listInventory() {
  const data = await getLifestyleStock()
  const items = (data.items ?? []).map(i => ({
    productId: i.sku,
    sku: i.sku,
    name: i.product,
    currentStock: Number(i.current_stock ?? i.stockQty ?? 0),
    reorderLevel: Number(i.reorder_level ?? 0),
    status: i.status,
  }))
  return { items, meta: { count: items.length }, summary: data.summary ?? {} }
}

export async function getInventoryProduct(productId: string) {
  const { items } = await listInventory()
  return items.find(i => i.productId === productId || i.sku === productId) ?? null
}

export async function adjustInventory(body: {
  adjustments: Array<{ sku: string; delta: number; reason: string }>
  note?: string
}) {
  const result = await serverPost(
    'inventory_adjust',
    agentActorPayload({ action: 'adjust', adjustments: body.adjustments, note: body.note }),
  )
  mirrorAllStockAfterGasWrite()
  return { status: 'adjusted', count: body.adjustments.length, result }
}

export async function listInventoryMovements(input: { sku?: string; limit?: number }) {
  const data = await serverGet<{ movements?: Array<Record<string, unknown>>; log?: Array<Record<string, unknown>> }>(
    'log',
    { limit: String(input.limit ?? 50), type: 'inventory' },
    0,
  )
  let rows = data.movements ?? data.log ?? []
  if (input.sku) rows = rows.filter(r => String(r.sku ?? r.reference ?? '').includes(input.sku!))
  return { movements: rows.slice(0, input.limit ?? 50), meta: { count: rows.length } }
}
