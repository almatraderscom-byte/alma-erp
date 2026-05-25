import type { StockItem } from '@/types'

export const LEGACY_MEN_COLLECTION_CODES = new Set([
  '133', '13', '231', '111', '475', '476', '240', '223', '224', '345',
  '609', '120', '130', '131', '150', '110', '115', '720', '20', '212',
])

export const MEN_SIZES = Array.from({ length: 20 }, (_, i) => String(16 + i * 2))
export const MEN_SIZE_GROUPS = ['KIDS', 'ADULT'] as const

export const WOMEN_VARIANT_GROUPS = [
  'ORNA',
  'TWO PIECE (1-5)',
  'TWO PIECE (6Y-9Y)',
  'TWO PIECE (10Y-14Y)',
  'THREE PIECE',
] as const

export const WOMEN_STOCK_VARIANT_GROUPS = ['ORNA', 'TWO PIECE', 'THREE PIECE'] as const

export type CollectionType = 'MEN' | 'WOMEN' | 'SINGLE' | 'CUSTOM'
export type SizeGroup = typeof MEN_SIZE_GROUPS[number]
export type WomenVariantGroup = typeof WOMEN_VARIANT_GROUPS[number] | string

export type CollectionInfo = {
  collectionCode: string
  collectionType: CollectionType
  baseCode: string
}

export function smartFashionSku(code: string, option: { size?: string; variantGroup?: string }) {
  const normalized = code.trim().toUpperCase().replace(/\s+/g, '')
  if (option.size) return `${normalized}-${String(option.size).trim().toUpperCase()}`
  const variant = normalizeWomenVariant(option.variantGroup)
  if (variant === 'ORNA') return `${normalized}-ORNA`
  if (variant === 'THREE PIECE') return `${normalized}-THREE-PIECE`
  if (variant === 'TWO PIECE') return `${normalized}-TWO-PIECE`
  if (option.variantGroup) {
    const slug = String(option.variantGroup).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '')
    return [normalized, slug].filter(Boolean).join('-')
  }
  return normalized
}

export function normalizeCollectionCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '')
}

export function parseCollectionCode(value: string, preferredType?: CollectionType): CollectionInfo | null {
  const code = value.trim().toUpperCase().replace(/\s+/g, '')
  if (!code) return null
  const baseCode = code.endsWith('T') ? code.slice(0, -1) : code
  if (preferredType) return { collectionCode: code, collectionType: preferredType, baseCode }
  if (/^[A-Z0-9-]+T$/.test(code)) return { collectionCode: code, collectionType: 'WOMEN', baseCode }
  if (LEGACY_MEN_COLLECTION_CODES.has(code)) return { collectionCode: code, collectionType: 'MEN', baseCode: code }
  return null
}

export function sizeGroupForSize(size: string): SizeGroup | undefined {
  const n = Number(size)
  if (!Number.isFinite(n)) return undefined
  if (n >= 16 && n <= 36) return 'KIDS'
  if (n >= 38 && n <= 54) return 'ADULT'
  return undefined
}

export function buyingPriceForStock(stock: StockItem | undefined): number {
  if (!stock) return 0
  if (stock.buyingPrice != null) return Number(stock.buyingPrice) || 0
  if (stock.current_stock > 0 && stock.stock_value > 0) return Math.round((stock.stock_value / stock.current_stock) * 100) / 100
  if (stock.opening > 0 && stock.stock_value > 0) return Math.round((stock.stock_value / stock.opening) * 100) / 100
  return 0
}

export function inferStockCollection(stock: StockItem): {
  collectionCode?: string
    collectionType?: CollectionType
  sizeGroup?: SizeGroup
  variantGroup?: WomenVariantGroup
} {
  const explicitCode = stock.collectionCode?.trim().toUpperCase()
  const explicitType = stock.collectionType?.trim().toUpperCase()
  const raw = [stock.sku, stock.product, stock.category, stock.color, stock.size].join(' ').toUpperCase()
  const codeMatch = explicitCode || raw.match(/\b[A-Z0-9][A-Z0-9-]{1,18}T?\b/)?.[0]
  const parsed = codeMatch ? parseCollectionCode(codeMatch) : null
  const sizeGroup = (stock.sizeGroup?.trim().toUpperCase() as SizeGroup | undefined) || sizeGroupForSize(stock.size)
  const variantGroup = normalizeWomenVariant(stock.variantGroup || stock.size || stock.color || stock.product)

  return {
    collectionCode: parsed?.collectionCode || explicitCode,
    collectionType: (explicitType && ['WOMEN', 'MEN', 'SINGLE', 'CUSTOM'].includes(explicitType) ? explicitType : parsed?.collectionType) as CollectionType | undefined,
    sizeGroup,
    variantGroup,
  }
}

export function normalizeWomenVariant(value: string | undefined): WomenVariantGroup | undefined {
  const v = String(value || '').toUpperCase()
  if (!v) return undefined
  if (v.includes('ORNA')) return 'ORNA'
  if (v.includes('THREE') || v.includes('3 PIECE') || v.includes('3PC')) return 'THREE PIECE'
  if (v.includes('TWO') || v.includes('2 PIECE') || v.includes('2PC') || v.includes('10Y') || v.includes('14Y') || v.includes('10-14') || v.includes('6Y') || v.includes('9Y') || v.includes('6-9') || v.includes('1Y') || v.includes('5Y') || v.includes('1-5') || v.includes('2Y') || v.includes('2-5')) return 'TWO PIECE'
  return undefined
}

export type CollectionVariantOption = {
  value: string
  label: string
  available: number
  sku: string
}

export function getCollectionVariantOptions(
  stockItems: StockItem[],
  collection: { collectionCode: string; collectionType: string },
): CollectionVariantOption[] {
  const code = collection.collectionCode
  const type = collection.collectionType
  const seen = new Map<string, CollectionVariantOption>()

  for (const stock of stockItems) {
    const meta = inferStockCollection(stock)
    if (meta.collectionCode !== code || meta.collectionType !== type) continue
    if (stock.active === false || stock.archived) continue
    const value = String(stock.variantGroup || stock.size || '').trim()
    if (!value) continue
    const key = value.toUpperCase()
    const available = Number(stock.available ?? 0)
    const existing = seen.get(key)
    if (!existing || available > existing.available) {
      seen.set(key, { value, label: value, available, sku: stock.sku || '' })
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
}

export function matchCollectionStock(
  stockItems: StockItem[],
  collection: CollectionInfo,
  selected: { size?: string; variant?: string },
): StockItem | undefined {
  const matches = stockItems
    .map(stock => ({ stock, meta: inferStockCollection(stock) }))
    .filter(({ meta }) => meta.collectionCode === collection.collectionCode && meta.collectionType === collection.collectionType)
  const activeMatches = matches.filter(({ stock }) => stock.active !== false && !stock.archived)

  if (collection.collectionType === 'MEN') {
    const group = sizeGroupForSize(selected.size || '')
    return activeMatches.find(({ meta }) => meta.sizeGroup === group)?.stock
      || activeMatches.find(({ stock }) => String(stock.size).trim().toUpperCase() === String(group || '').trim().toUpperCase())?.stock
      || activeMatches.find(({ stock }) => String(stock.size).trim() === String(selected.size || '').trim())?.stock
      || matches.find(({ meta }) => meta.sizeGroup === group)?.stock
      || matches.find(({ stock }) => String(stock.size).trim() === String(selected.size || '').trim())?.stock
  }

  if (collection.collectionType === 'CUSTOM' || collection.collectionType === 'SINGLE') {
    const target = String(selected.variant || selected.size || '').trim().toUpperCase()
    if (!target) return undefined
    return activeMatches.find(({ meta, stock }) =>
      String(meta.variantGroup || '').trim().toUpperCase() === target
      || String(stock.size || '').trim().toUpperCase() === target
      || String(stock.variantGroup || '').trim().toUpperCase() === target,
    )?.stock
      || matches.find(({ meta, stock }) =>
        String(meta.variantGroup || '').trim().toUpperCase() === target
        || String(stock.variantGroup || stock.size || '').trim().toUpperCase() === target,
      )?.stock
  }

  const variant = normalizeWomenVariant(selected.variant) || String(selected.variant || '').trim()
  return activeMatches.find(({ meta }) => meta.variantGroup === variant)?.stock
    || activeMatches.find(({ stock }) => String(stock.variantGroup || stock.size || stock.color).trim().toUpperCase() === String(variant).toUpperCase())?.stock
    || matches.find(({ meta }) => meta.variantGroup === variant)?.stock
    || matches.find(({ stock }) => String(stock.variantGroup || stock.size || stock.color).trim().toUpperCase() === String(variant).toUpperCase())?.stock
}

export function detectCollectionFromStock(stockItems: StockItem[], value: string): CollectionInfo | null {
  const code = normalizeCollectionCode(value)
  if (!code) return null
  const match = stockItems
    .map(stock => ({ stock, meta: inferStockCollection(stock) }))
    .find(({ meta }) => meta.collectionCode === code && meta.collectionType)
  if (match?.meta.collectionType) {
    return { collectionCode: code, collectionType: match.meta.collectionType, baseCode: code.endsWith('T') ? code.slice(0, -1) : code }
  }
  return parseCollectionCode(code)
}
