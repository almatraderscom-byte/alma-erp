/**
 * Read-only inventory access for CS-0 catalog (SKU = product code).
 * Stock API returns one row per SKU/variant; sizes live in size / sizeValue fields.
 */
import { serverGet } from '@/lib/server-api'
import { DEFAULT_AGENT_BUSINESS_ID } from '@/lib/agent-api/constants'
import type { Order, StockItem } from '@/types'

export const DEFAULT_CATALOG_BUSINESS = DEFAULT_AGENT_BUSINESS_ID
export const DEFAULT_CATALOG_BUSINESS_LABEL = 'ALMA Lifestyle'

export type CatalogStockRow = {
  sku: string
  name: string
  category: string
  size: string
  sizeValue: string
  sizeCategory: string
  genderType: string
  collectionType: string
  currentStock: number
  sellPrice: number
  business: string
}

let stockCache: { at: number; rows: CatalogStockRow[] } | null = null
const CACHE_MS = 60_000

const BN_DIGITS = '০১২৩৪৫৬৭৮৯'

function bnDigitsToAscii(raw: string): string {
  return raw.replace(/[০-৯]/g, (ch) => {
    const i = BN_DIGITS.indexOf(ch)
    return i >= 0 ? String(i) : ch
  })
}

export function normalizeProductCode(raw: string): string {
  let s = bnDigitsToAscii(String(raw ?? '').trim())
  s = s.toUpperCase().replace(/\s+/g, '')
  // Marketing captions: "Code-345", "ALM-345", "FM-345"
  s = s.replace(/^(FM|ALM|CODE|REF|SKU|কোড)[-:]/i, '')
  s = s.replace(/_/g, '-')
  return s
}

function rowFromStock(item: StockItem): CatalogStockRow {
  return {
    sku: normalizeProductCode(item.sku),
    name: String(item.product ?? ''),
    category: String(item.category ?? ''),
    size: String(item.size ?? ''),
    sizeValue: String(item.sizeValue ?? item.size ?? ''),
    sizeCategory: String(item.sizeCategory ?? item.sizeGroup ?? ''),
    genderType: String(item.genderType ?? ''),
    collectionType: String(item.collectionType ?? ''),
    currentStock: Number(item.current_stock ?? item.stockQty ?? 0),
    sellPrice: Number(item.sell_value ?? 0),
    business: DEFAULT_CATALOG_BUSINESS,
  }
}

async function fetchStockItems(): Promise<StockItem[]> {
  const data = await serverGet<{ items?: StockItem[] }>('stock', {}, 0)
  return data.items ?? []
}

export async function loadCatalogStock(force = false): Promise<CatalogStockRow[]> {
  const now = Date.now()
  if (!force && stockCache && now - stockCache.at < CACHE_MS) return stockCache.rows
  const items = await fetchStockItems()
  const rows: CatalogStockRow[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const row = rowFromStock(item)
    if (!row.sku || seen.has(row.sku)) continue
    seen.add(row.sku)
    rows.push(row)
  }
  stockCache = { at: now, rows }
  return rows
}

export async function loadVariantsForCode(code: string): Promise<CatalogStockRow[]> {
  const norm = normalizeProductCode(code)
  const items = await fetchStockItems()
  return items.map(rowFromStock).filter((r) => r.sku === norm)
}

export async function loadAllStockRows(): Promise<CatalogStockRow[]> {
  const items = await fetchStockItems()
  return items.map(rowFromStock).filter((r) => r.sku)
}

export async function resolveProductCode(
  raw: string,
): Promise<{ ok: true; code: string; row: CatalogStockRow } | { ok: false; suggestions: string[] }> {
  const norm = normalizeProductCode(raw)
  if (!norm) return { ok: false, suggestions: [] }

  const rows = await loadCatalogStock()
  const exact = rows.find((r) => r.sku === norm)
  if (exact) return { ok: true, code: exact.sku, row: exact }

  const prefixMatches = rows.filter((r) => r.sku.startsWith(`${norm}-`))
  if (prefixMatches.length === 1) {
    return { ok: true, code: prefixMatches[0].sku, row: prefixMatches[0] }
  }
  if (prefixMatches.length > 1) {
    const preferred =
      prefixMatches.find((r) => /-ADULT$/i.test(r.sku))
      ?? prefixMatches.find((r) => /-\d+$/i.test(r.sku))
      ?? prefixMatches[0]
    return { ok: true, code: preferred.sku, row: preferred }
  }

  const suggestions = [
    ...prefixMatches.map((r) => r.sku),
    ...fuzzySuggest(norm, rows.map((r) => r.sku), 3),
  ].filter((v, i, a) => a.indexOf(v) === i).slice(0, 3)
  return { ok: false, suggestions }
}

function fuzzySuggest(query: string, codes: string[], limit: number): string[] {
  const scored = codes
    .map((c) => ({ c, d: editDistance(query, c) }))
    .filter((x) => x.d <= 4 || x.c.includes(query) || query.includes(x.c))
    .sort((a, b) => a.d - b.d)
  return [...new Set(scored.map((x) => x.c))].slice(0, limit)
}

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[m][n]
}

export async function getRecentSalesSkus(days = 30, limit = 50): Promise<string[]> {
  const end = new Date()
  const start = new Date(end.getTime() - days * 86_400_000)
  const data = await serverGet<{ orders?: Order[] }>('orders', {
    business_id: DEFAULT_AGENT_BUSINESS_ID,
    limit: '500',
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  }, 0)
  const counts = new Map<string, number>()
  for (const o of data.orders ?? []) {
    const lineSkus = (o.items ?? []).map((it) => it.sku || it.product_code || '').filter(Boolean)
    const skus = lineSkus.length ? lineSkus : [o.sku || o.product || '']
    for (const raw of skus) {
      const sku = normalizeProductCode(String(raw))
      if (!sku) continue
      counts.set(sku, (counts.get(sku) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k)
}
