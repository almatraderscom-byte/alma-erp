/**
 * Supplier bulk import — shared types & pure helpers (no credentials).
 * Scraped JSON is produced offline by scripts/smartchinahub-scraper.mjs (Playwright CDP + .env).
 */

export const SUPPLIER_IMPORT_DEFAULT = 'SmartChinaHub'
export const SUPPLIER_IMPORT_CHUNK = 35

export type SupplierProductDraft = {
  /** Stable id from supplier (strong duplicate key) */
  supplier_product_id?: string
  name: string
  product?: string
  category?: string
  /** Sell price in your workbook currency */
  price?: number
  default_price?: number
  /** Cost / COGS */
  cogs?: number
  default_cogs?: number
  image_url?: string
  image?: string
  /** Raw stock label from portal */
  stock_text?: string
  variants?: unknown[]
  variants_json?: string
  description?: string
  notes?: string
  sku?: string
  supplier?: string
  active?: boolean
}

export type CatalogProduct = {
  id: string
  sku?: string
  name: string
  category: string
  default_price: number
  default_cogs: number
  active: boolean
  notes: string
}

export type DuplicateReason = 'duplicate_sku' | 'duplicate_supplier_id' | 'duplicate_name' | 'invalid' | null

export type EnrichedDraft = SupplierProductDraft & {
  _rowId: string
  _selected: boolean
  _duplicate: DuplicateReason
  _issues: string[]
  _mappedCategory: string
}

function slugKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s-]/gi, '')
}

export function applyCategoryMap(category: string | undefined, map: Record<string, string>): string {
  if (!category) return ''
  const t = category.trim()
  if (map[t]) return map[t]
  const k = slugKey(t)
  for (const [from, to] of Object.entries(map)) {
    if (slugKey(from) === k) return to
  }
  return t
}

export function validateDraft(d: SupplierProductDraft): string[] {
  const issues: string[] = []
  const name = String(d.name || d.product || '').trim()
  if (!name) issues.push('Missing product name')
  const price = Number(d.default_price ?? d.price ?? NaN)
  if (name && Number.isNaN(price)) issues.push('Price invalid (use a number)')
  if (name && !Number.isNaN(price) && price < 0) issues.push('Price cannot be negative')
  return issues
}

function catalogSets(catalog: CatalogProduct[]) {
  const skus = new Set<string>()
  const names = new Set<string>()
  for (const p of catalog) {
    const sku = String(p.sku || p.id || '').trim().toLowerCase()
    if (sku) skus.add(sku)
    names.add(String(p.name || '').trim().toLowerCase())
  }
  return { skus, names }
}

export function enrichDrafts(
  drafts: SupplierProductDraft[],
  catalog: CatalogProduct[],
  categoryMap: Record<string, string>,
): EnrichedDraft[] {
  const { skus, names } = catalogSets(catalog)
  const seenSku = new Set<string>()
  const seenFile = new Set<string>()

  return drafts.map((raw, i) => {
    const name = String(raw.name || raw.product || '').trim()
    const sku = String(raw.sku || '').trim()
    const sid = String(raw.supplier_product_id || '').trim()
    const mapped = applyCategoryMap(raw.category, categoryMap)
    const issues = validateDraft({ ...raw, name, category: mapped })

    const fileKey = sid ? `sid:${sid.toLowerCase()}` : `n:${slugKey(name)}`

    let dup: DuplicateReason = null
    const ln = name.toLowerCase()
    const ls = sku.toLowerCase()

    if (issues.includes('Missing product name')) dup = 'invalid'
    else if (seenFile.has(fileKey)) dup = sid ? 'duplicate_supplier_id' : 'duplicate_name'
    else seenFile.add(fileKey)

    if (!dup && sku && (skus.has(ls) || seenSku.has(ls))) dup = 'duplicate_sku'
    if (!dup && name && names.has(ln)) dup = 'duplicate_name'

    if (sku) seenSku.add(ls)

    const selectable = issues.length === 0 && dup === null

    return {
      ...raw,
      name,
      product: name,
      category: mapped,
      supplier: raw.supplier || SUPPLIER_IMPORT_DEFAULT,
      _rowId: `r-${i}-${sid || slugKey(name).slice(0, 24) || 'x'}`,
      _selected: selectable,
      _duplicate: dup,
      _issues: issues,
      _mappedCategory: mapped,
    }
  })
}

export function draftsToPayload(rows: EnrichedDraft[]): SupplierProductDraft[] {
  return rows
    .filter(r => r._selected && r._duplicate !== 'invalid')
    .map(r => ({
      supplier_product_id: r.supplier_product_id,
      name: r.name,
      category: r._mappedCategory || r.category,
      default_price: Number(r.default_price ?? r.price ?? 0),
      default_cogs: Number(r.default_cogs ?? r.cogs ?? 0),
      image_url: r.image_url || r.image,
      description: r.description,
      notes: r.notes,
      sku: r.sku,
      supplier: r.supplier || SUPPLIER_IMPORT_DEFAULT,
      variants: r.variants,
      variants_json: r.variants_json,
      stock_text: r.stock_text,
      active: r.active !== false,
    }))
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
