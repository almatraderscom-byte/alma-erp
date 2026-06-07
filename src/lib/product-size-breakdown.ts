import { sizeGroupForSize } from '@/components/orders/new-order/collection-engine'
import type { Order, OrderItem } from '@/types'

export interface ProductSizeSlice {
  label: string
  pieces: number
}

export interface ProductLineForBreakdown {
  code: string
  label: string
  qty: number
  revenueShare: number
}

/** Strip "+ N more" suffix and extract collection code (e.g. "133 ADULT + 2 more" → "133"). */
export function normalizeProductCode(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return 'Unknown'
  const withoutMore = s.replace(/\s*\+\s*\d+\s+more\s*$/i, '').trim()
  const numeric = withoutMore.match(/^(\d{2,3}[A-Z]?)\b/i)
  if (numeric) return numeric[1].toUpperCase()
  const code = withoutMore.match(/^([A-Z0-9][A-Z0-9-]{0,18}T?)\b/i)
  if (code) return code[1].toUpperCase()
  return withoutMore.split(/\s+/)[0]?.toUpperCase() || 'Unknown'
}

function labelFromProductText(product: string): string | undefined {
  const match = String(product || '').match(/\b(ADULT|KIDS)\b/i)
  return match ? match[1].toUpperCase() : undefined
}

export function variantLabelForItem(item: Pick<OrderItem, 'product' | 'size' | 'variant' | 'size_group' | 'variant_group'>): string {
  const sizeGroup = item.size_group?.trim().toUpperCase()
  if (sizeGroup === 'KIDS' || sizeGroup === 'ADULT') return sizeGroup

  const variantGroup = item.variant_group?.trim()
  if (variantGroup) return variantGroup

  const variant = item.variant?.trim()
  if (variant) return variant

  const size = item.size?.trim()
  if (size) {
    const group = sizeGroupForSize(size)
    if (group) return group
    return size
  }

  return labelFromProductText(item.product) || 'Other'
}

function variantLabelFromOrder(o: Order): string {
  const fromProduct = labelFromProductText(o.product)
  if (fromProduct) return fromProduct
  const size = o.size?.trim()
  if (size) {
    const group = sizeGroupForSize(size)
    if (group) return group
    return size
  }
  return o.category?.trim() || 'Other'
}

/** Expand an order into product lines with qty and revenue share for dashboard aggregation. */
export function expandOrderProductLines(o: Order): ProductLineForBreakdown[] {
  const items = o.items?.filter(it => Number(it.qty) > 0) ?? []
  if (items.length) {
    const subtotalSum = items.reduce((sum, it) => sum + Math.max(0, Number(it.subtotal) || 0), 0)
    const fallbackShare = items.length > 0 ? 1 / items.length : 1
    return items.map(item => {
      const subtotal = Math.max(0, Number(item.subtotal) || 0)
      const revenueShare = subtotalSum > 0 ? subtotal / subtotalSum : fallbackShare
      return {
        code: normalizeProductCode(item.product_code || item.collection_code || item.product || o.product || o.category),
        label: variantLabelForItem(item),
        qty: Number(item.qty) || 0,
        revenueShare,
      }
    })
  }

  const qty = Math.max(1, Number(o.qty) || 1)
  return [{
    code: normalizeProductCode(o.product || o.category),
    label: variantLabelFromOrder(o),
    qty,
    revenueShare: 1,
  }]
}

export function buildSizeBreakdown(slices: Record<string, number>): ProductSizeSlice[] {
  return Object.entries(slices)
    .map(([label, pieces]) => ({ label, pieces }))
    .filter(s => s.pieces > 0)
    .sort((a, b) => b.pieces - a.pieces)
}
