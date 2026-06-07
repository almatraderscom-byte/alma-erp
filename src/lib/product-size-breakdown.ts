import { sizeGroupForSize } from '@/components/orders/new-order/collection-engine'
import type { Order, OrderItem } from '@/types'

export interface ProductSizeSlice {
  label: string
  pieces: number
}

export interface ProductGroupSizeDetail {
  group: string
  pieces: number
  top_size: ProductSizeSlice | null
  size_breakdown: ProductSizeSlice[]
}

export interface ProductLineForBreakdown {
  code: string
  groupLabel: string
  specificSize: string | null
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

export function groupLabelForItem(
  item: Pick<OrderItem, 'product' | 'size' | 'variant' | 'size_group' | 'variant_group'>,
): string {
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
    if (!/^(ADULT|KIDS)$/i.test(size)) return size
  }

  return labelFromProductText(item.product) || 'Other'
}

export function specificSizeForItem(
  item: Pick<OrderItem, 'product' | 'size' | 'variant' | 'sku' | 'stock_sku'>,
): string | null {
  const size = item.size?.trim()
  if (size && !/^(ADULT|KIDS)$/i.test(size)) {
    const n = Number(size)
    if (Number.isFinite(n) && n >= 16 && n <= 54) return String(n)
    return size
  }

  const variant = item.variant?.trim()
  if (variant && !/^(ADULT|KIDS)$/i.test(variant)) return variant

  const sku = String(item.stock_sku || item.sku || '').trim()
  const fromSku = sku.match(/-(\d{2})$/)
  if (fromSku) return fromSku[1]

  return null
}

/** @deprecated Use groupLabelForItem — kept for scripts referencing old name. */
export function variantLabelForItem(
  item: Pick<OrderItem, 'product' | 'size' | 'variant' | 'size_group' | 'variant_group'>,
): string {
  return groupLabelForItem(item)
}

function groupLabelFromOrder(o: Order): string {
  const fromProduct = labelFromProductText(o.product)
  if (fromProduct) return fromProduct
  const size = o.size?.trim()
  if (size) {
    const group = sizeGroupForSize(size)
    if (group) return group
    if (!/^(ADULT|KIDS)$/i.test(size)) return size
  }
  return o.category?.trim() || 'Other'
}

function specificSizeFromOrder(o: Order): string | null {
  const size = o.size?.trim()
  if (size && !/^(ADULT|KIDS)$/i.test(size)) {
    const n = Number(size)
    if (Number.isFinite(n) && n >= 16 && n <= 54) return String(n)
    return size
  }
  const fromSku = String(o.sku || '').match(/-(\d{2})$/)
  return fromSku ? fromSku[1] : null
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
        groupLabel: groupLabelForItem(item),
        specificSize: specificSizeForItem(item),
        qty: Number(item.qty) || 0,
        revenueShare,
      }
    })
  }

  const qty = Math.max(1, Number(o.qty) || 1)
  return [{
    code: normalizeProductCode(o.product || o.category),
    groupLabel: groupLabelFromOrder(o),
    specificSize: specificSizeFromOrder(o),
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

export function buildGroupSizeDetails(
  groupSlices: Record<string, number>,
  specificByGroup: Record<string, Record<string, number>>,
): ProductGroupSizeDetail[] {
  return Object.entries(groupSlices)
    .map(([group, pieces]) => {
      const size_breakdown = buildSizeBreakdown(specificByGroup[group] ?? {})
      return {
        group,
        pieces,
        top_size: size_breakdown[0] ?? null,
        size_breakdown: size_breakdown.slice(0, 3),
      }
    })
    .filter(g => g.pieces > 0)
    .sort((a, b) => b.pieces - a.pieces)
}

/** Compact label for dashboard rows, e.g. "ADULT 177 pcs · sz 42 (45) · 40 (38)". */
export function formatGroupSizeLine(detail: ProductGroupSizeDetail): string {
  const sizes = detail.size_breakdown
    .slice(0, 2)
    .map(s => `${s.label} (${s.pieces})`)
    .join(' · ')
  const base = `${detail.group} ${detail.pieces} pcs`
  return sizes ? `${base} · sz ${sizes}` : base
}
