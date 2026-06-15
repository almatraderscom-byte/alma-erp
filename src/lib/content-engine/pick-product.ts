import { prisma } from '@/lib/prisma'
import { normalizeProductCode, loadCatalogStock } from '@/agent/lib/catalog/inventory-lookup'
import { listWebsiteProducts } from '@/lib/website/catalog.service'
import { websiteSupabaseConfigured } from '@/lib/website/supabase-client'
import type { ProductAsset } from '@/lib/content-engine/generate-variants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type PickProductOpts = {
  /** Skip products posted within this many days (default 2). */
  minDaysBetween?: number
  /** Exclude these product codes (e.g. already prepped today). */
  excludeCodes?: string[]
}

export type PickProductResult =
  | { ok: true; product: ProductAsset; reason: string }
  | { ok: false; reason: string }

function mapRow(row: {
  productCode: string
  name: string | null
  category: string | null
  fabric: string | null
  imagePath: string
  familyMatch: boolean
}): ProductAsset {
  return {
    productCode: row.productCode,
    name: row.name,
    category: row.category,
    fabric: row.fabric,
    imagePath: row.imagePath,
    familyMatch: row.familyMatch,
  }
}

function skuMatchesCode(sku: string, code: string): boolean {
  const nSku = normalizeProductCode(sku)
  const nCode = normalizeProductCode(code)
  if (!nCode) return false
  return nSku === nCode || nSku.startsWith(nCode) || nCode.startsWith(nSku)
}

async function erpHasStock(productCode: string): Promise<boolean> {
  const rows = await loadCatalogStock()
  const code = normalizeProductCode(productCode)
  let total = 0
  for (const r of rows) {
    if (skuMatchesCode(r.sku, code) || skuMatchesCode(r.collectionCode, code)) {
      total += r.currentStock
    }
  }
  return total > 0
}

async function websiteIsPublished(productCode: string): Promise<boolean> {
  if (!websiteSupabaseConfigured()) return true
  try {
    const products = await listWebsiteProducts({ publishedOnly: true, limit: 500 })
    const code = normalizeProductCode(productCode)
    for (const p of products) {
      if (!skuMatchesCode(p.sku, code)) continue
      if (p.published && p.stock > 0) return true
    }
    return false
  } catch {
    return true
  }
}

function recentlyPosted(lastPostedAt: Date | null, minDays: number, now = new Date()): boolean {
  if (!lastPostedAt) return false
  const ms = now.getTime() - new Date(lastPostedAt).getTime()
  return ms < minDays * 24 * 60 * 60 * 1000
}

/**
 * Pick the next eligible product for autonomous content prep.
 * Least-recently-posted first; must be in stock + published on website.
 */
export async function pickNextProduct(opts: PickProductOpts = {}): Promise<PickProductResult> {
  const minDays = opts.minDaysBetween ?? 2
  const exclude = new Set((opts.excludeCodes ?? []).map((c) => normalizeProductCode(c)))

  const rows = await db.productContentAsset.findMany({
    orderBy: [{ lastPostedAt: 'asc' }, { createdAt: 'asc' }],
  })

  if (!rows.length) {
    return { ok: false, reason: 'no_content_assets' }
  }

  for (const row of rows) {
    const code = row.productCode as string
    if (exclude.has(normalizeProductCode(code))) continue
    if (recentlyPosted(row.lastPostedAt, minDays)) continue

    const inStock = await erpHasStock(code)
    if (!inStock) continue

    const onWeb = await websiteIsPublished(code)
    if (!onWeb) continue

    return {
      ok: true,
      product: mapRow(row),
      reason: `least_recently_posted (lastPostedAt=${row.lastPostedAt ?? 'never'})`,
    }
  }

  return { ok: false, reason: 'no_eligible_product' }
}
