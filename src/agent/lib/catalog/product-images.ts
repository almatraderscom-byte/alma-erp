import { prisma } from '@/lib/prisma'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'
import {
  DEFAULT_CATALOG_BUSINESS,
  normalizeProductCode,
  resolveProductInput,
  loadAllStockRows,
} from '@/agent/lib/catalog/inventory-lookup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export function businessStorageSlug(business: string): string {
  return business.toLowerCase().replace(/_/g, '-')
}

/**
 * A stored Supabase signed URL embeds a JWT with an `exp` claim. It's only usable
 * while it has comfortable life left — Supabase answers 400 InvalidJWT the moment
 * it expires, which shows up as broken thumbnails everywhere the URL is reused.
 * Uploads sign for 7 days, so any URL cached in the DB longer than that is dead;
 * this treats a URL as fresh only when it has > 6h remaining, so links never die
 * mid-view. null / unparseable → not fresh, so the caller re-signs.
 */
function signedUrlFresh(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const token = new URL(url).searchParams.get('token')
    const payload = token?.split('.')[1]
    if (!payload) return false
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number }
    if (typeof claims.exp !== 'number') return false
    return claims.exp * 1000 - Date.now() > 6 * 3600 * 1000
  } catch {
    return false
  }
}

/**
 * Return a signed URL guaranteed to be currently valid. Reuses the stored one
 * while it still has life left (the fast path); otherwise re-signs and writes the
 * fresh URL back so later reads stay fast. Never throws — falls back to whatever
 * was stored if signing itself fails.
 */
async function ensureFreshSignedUrl(
  row: { id?: string; url: string | null; storagePath: string },
  expiresIn: number,
): Promise<string | null> {
  if (signedUrlFresh(row.url)) return row.url
  try {
    const url = await agentStorageSignedUrl(row.storagePath, expiresIn)
    if (row.id) {
      try {
        await db.productImage.update({ where: { id: row.id }, data: { url } })
      } catch {
        // cache write-back is best-effort — a fresh URL is still returned below
      }
    }
    return url
  } catch {
    return row.url ?? null
  }
}

export async function countImagesForCode(productCode: string, business = DEFAULT_CATALOG_BUSINESS) {
  const code = normalizeProductCode(productCode)
  return db.productImage.count({ where: { productCode: code, business } })
}

export type AddProductImageResult =
  | { ok: true; code: string; total: number; isPrimary: boolean }
  | { ok: true; collection: string; codes: string[]; results: Array<{ code: string; total: number; isPrimary: boolean }> }
  | { ok: false; reason: string; suggestions?: string[] }

export async function addProductImage(input: {
  productCode: string
  business?: string
  imageBuffer: Buffer
  uploadedByChatId?: string
  contentType?: string
}): Promise<AddProductImageResult> {
  const business = input.business ?? DEFAULT_CATALOG_BUSINESS
  const resolved = await resolveProductInput(input.productCode)

  if (resolved.kind === 'not_found') {
    return { ok: false, reason: 'invalid_code', suggestions: resolved.suggestions }
  }

  const targetCodes =
    resolved.kind === 'collection'
      ? resolved.members.map((m) => m.sku)
      : [resolved.code]

  const slug = businessStorageSlug(business)
  const results: Array<{ code: string; total: number; isPrimary: boolean }> = []

  for (const code of targetCodes) {
    const existing = await db.productImage.count({ where: { productCode: code, business } })
    const index = existing + 1
    const storagePath = `product-images/${slug}/${code}/${index}.jpg`

    await agentStorageUpload(storagePath, input.imageBuffer, input.contentType ?? 'image/jpeg')
    let url: string | null = null
    try {
      url = await agentStorageSignedUrl(storagePath, 86400 * 7)
    } catch {
      url = null
    }

    const isPrimary = existing === 0
    await db.productImage.create({
      data: {
        productCode: code,
        business,
        storagePath,
        url,
        isPrimary,
        uploadedByChatId: input.uploadedByChatId ?? null,
      },
    })
    results.push({ code, total: index, isPrimary })
  }

  if (resolved.kind === 'collection') {
    return {
      ok: true,
      collection: resolved.collectionCode,
      code: resolved.collectionCode,
      codes: results.map((r) => r.code),
      results,
      total: results.reduce((sum, r) => sum + r.total, 0),
    }
  }

  const first = results[0]
  return { ok: true, code: first.code, total: first.total, isPrimary: first.isPrimary }
}

/**
 * Add an image for a BRAND-NEW product code that does not (yet) exist in ERP
 * inventory — for products the owner is adding ahead of inventory sync. Unlike
 * addProductImage this skips the inventory resolve / invalid_code check and just
 * writes to the productImage store (no ERP inventory mutation). The new code then
 * surfaces in the catalog grid via listCatalogForImages (custom-code merge).
 */
export async function addCustomProductImage(input: {
  productCode: string
  business?: string
  imageBuffer: Buffer
  uploadedByChatId?: string
  contentType?: string
}): Promise<{ ok: true; code: string; total: number; isPrimary: boolean } | { ok: false; reason: string }> {
  const business = input.business ?? DEFAULT_CATALOG_BUSINESS
  const code = normalizeProductCode(input.productCode)
  if (!code) return { ok: false, reason: 'empty_code' }

  const existing = await db.productImage.count({ where: { productCode: code, business } })
  const index = existing + 1
  const slug = businessStorageSlug(business)
  const storagePath = `product-images/${slug}/${code}/${index}.jpg`

  await agentStorageUpload(storagePath, input.imageBuffer, input.contentType ?? 'image/jpeg')
  let url: string | null = null
  try {
    url = await agentStorageSignedUrl(storagePath, 86400 * 7)
  } catch {
    url = null
  }

  const isPrimary = existing === 0
  await db.productImage.create({
    data: {
      productCode: code,
      business,
      storagePath,
      url,
      isPrimary,
      uploadedByChatId: input.uploadedByChatId ?? null,
    },
  })
  return { ok: true, code, total: index, isPrimary }
}

export type ProductImageEntry = {
  id: string
  url: string | null
  storagePath: string
  isPrimary: boolean
}

/**
 * Returns ALL images for a product code (not just the primary), primary first.
 * Re-signs storage URLs on the fly when the stored URL is missing/expired so the
 * agent (and CS) always receive a usable link. Limited to `limit` images.
 */
/** Storage paths whose object is a plausible image (≥1 KB). A failed upload leaves
 * a ~4-byte object; picking one as a generate_image reference fails the whole
 * render with Google's "Unable to process input image" (owner incident
 * 2026-07-13: 133-ADULT/1.jpg is 4 bytes). Uses the storage REST list API — the
 * earlier raw-SQL storage.objects check silently lacked privileges under the
 * app's DB role and no-op'd (the "fixed but not fixed" round). Filtering and
 * failures both log loudly so a prod no-op can never hide again. */
async function healthyStoragePaths(paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()
  const byFolder = new Map<string, string[]>()
  for (const p of paths) {
    const cut = p.lastIndexOf('/')
    if (cut <= 0) continue
    const folder = p.slice(0, cut)
    const arr = byFolder.get(folder)
    if (arr) arr.push(p)
    else byFolder.set(folder, [p])
  }
  const healthy = new Set<string>()
  await Promise.all(
    Array.from(byFolder.keys()).map(async (folder) => {
      try {
        const { agentStorageListFolder } = await import('@/agent/lib/storage')
        const entries = await agentStorageListFolder(folder)
        const sizeByName = new Map(entries.map((e) => [e.name, e.size]))
        for (const p of byFolder.get(folder) ?? []) {
          const size = sizeByName.get(p.slice(folder.length + 1))
          if (size == null || size >= 1024) {
            healthy.add(p)   // unknown (not listed) fails OPEN; known-tiny is dropped
          } else {
            console.warn(`[product-images] dropping corrupt catalog image ${p} (${size} bytes)`)
          }
        }
      } catch (err) {
        console.warn(`[product-images] storage list failed for ${folder} — keeping its images unfiltered:`,
          err instanceof Error ? err.message : err)
        for (const p of byFolder.get(folder) ?? []) healthy.add(p)
      }
    }),
  )
  return healthy
}

export async function listProductImages(
  productCode: string,
  business = DEFAULT_CATALOG_BUSINESS,
  limit = 8,
): Promise<ProductImageEntry[]> {
  const code = normalizeProductCode(productCode)
  let rows = await db.productImage.findMany({
    where: { productCode: code, business },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    take: limit,
  })
  // Corrupt uploads never leave this function — not as gallery thumbs, not as
  // generate_image references.
  const healthy = await healthyStoragePaths(
    (rows as Array<{ storagePath: string }>).map((r) => r.storagePath),
  )
  rows = (rows as Array<{ storagePath: string }>).filter((r) => healthy.has(r.storagePath))
  // Re-sign in parallel: a gallery of expired URLs would otherwise be N serial
  // Supabase round-trips (and, unfixed, N broken thumbnails).
  return Promise.all(
    (rows as Array<{ id: string; url: string | null; storagePath: string; isPrimary: boolean }>).map(
      async (row) => ({
        id: row.id,
        url: await ensureFreshSignedUrl(row, 86400),
        storagePath: row.storagePath,
        isPrimary: Boolean(row.isPrimary),
      }),
    ),
  )
}

/**
 * Delete one photo from a product/collection. For a family set the same photo was
 * replicated to every member at the same storage index, so we remove that index
 * across all members — otherwise the photo would linger on the other members.
 */
export async function deleteImageFromGroup(
  groupCode: string,
  imageId: string,
  business = DEFAULT_CATALOG_BUSINESS,
): Promise<{ ok: boolean; deleted: number }> {
  const row = (await db.productImage.findUnique({ where: { id: imageId } })) as
    | { storagePath: string; productCode: string }
    | null
  if (!row) return { ok: false, deleted: 0 }

  const idxMatch = String(row.storagePath).match(/\/(\d+)\.jpg$/i)
  const resolved = await resolveProductInput(groupCode)
  const codes =
    resolved.kind === 'collection'
      ? resolved.members.map((m) => m.sku)
      : resolved.kind === 'sku'
        ? [resolved.code]
        : [row.productCode]

  if (idxMatch) {
    const del = await db.productImage.deleteMany({
      where: { business, productCode: { in: codes }, storagePath: { endsWith: `/${idxMatch[1]}.jpg` } },
    })
    return { ok: true, deleted: del.count }
  }
  await db.productImage.delete({ where: { id: imageId } })
  return { ok: true, deleted: 1 }
}

export async function getPrimaryImageUrl(productCode: string, business = DEFAULT_CATALOG_BUSINESS): Promise<string | null> {
  const code = normalizeProductCode(productCode)
  const row = await db.productImage.findFirst({
    where: { productCode: code, business },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  })
  if (!row) return null
  return ensureFreshSignedUrl(
    { id: row.id, url: row.url, storagePath: row.storagePath },
    86400 * 7,
  )
}

export async function deleteImagesForCode(productCode: string, business = DEFAULT_CATALOG_BUSINESS) {
  const code = normalizeProductCode(productCode)
  const deleted = await db.productImage.deleteMany({ where: { productCode: code, business } })
  return { code, deleted: deleted.count }
}

export type CatalogImageGroup = {
  /** The code to upload against — collection base when it's a family set, else the SKU. */
  code: string
  name: string
  category: string
  kind: 'collection' | 'sku'
  /** Member SKUs (a family set has several; a plain product has one). */
  members: string[]
  imageCount: number
  hasImages: boolean
  primaryImageUrl: string | null
}

/**
 * Group every catalog product for the image-upload screen. Family-matching sets
 * (rows that share a collectionCode — e.g. father/son/mother/daughter of code 133)
 * collapse into ONE card; uploading against that card applies the photos to all
 * members. Plain products are their own card. Image counts come from the actual
 * product_images store (which is separate from inventory — inventory has no images).
 */
export async function listCatalogForImages(business = DEFAULT_CATALOG_BUSINESS): Promise<{
  groups: CatalogImageGroup[]
  totalGroups: number
  withImages: number
  missing: number
}> {
  const rows = await loadAllStockRows()

  // Count images per product code in one query.
  const counts = await db.productImage.groupBy({
    by: ['productCode'],
    where: { business },
    _count: { _all: true },
  })
  const countByCode = new Map<string, number>(
    (counts as Array<{ productCode: string; _count: { _all: number } }>).map((c) => [c.productCode, c._count._all]),
  )

  // Group by collectionCode when present, else by the SKU itself.
  const groups = new Map<string, { code: string; name: string; category: string; members: string[] }>()
  for (const r of rows) {
    const key = r.collectionCode && r.collectionCode.length ? r.collectionCode : r.sku
    const g = groups.get(key)
    if (g) {
      if (!g.members.includes(r.sku)) g.members.push(r.sku)
    } else {
      groups.set(key, { code: key, name: r.name || key, category: r.category || '', members: [r.sku] })
    }
  }

  // Resolve every primary thumbnail concurrently — each may need a fresh signature
  // (see ensureFreshSignedUrl), so a serial loop over ~60 groups would be ~60
  // Supabase round-trips and could blow the function timeout.
  const out: CatalogImageGroup[] = await Promise.all(
    Array.from(groups.values()).map(async (g) => {
      const isCollection = g.members.length > 1
      const imageCount = g.members.reduce((max, m) => Math.max(max, countByCode.get(m) ?? 0), 0)
      const withImage = g.members.find((m) => (countByCode.get(m) ?? 0) > 0)
      return {
        code: g.code,
        name: g.name,
        category: g.category,
        kind: isCollection ? 'collection' : 'sku',
        members: g.members,
        imageCount,
        hasImages: imageCount > 0,
        primaryImageUrl: withImage ? await getPrimaryImageUrl(withImage, business).catch(() => null) : null,
      } as CatalogImageGroup
    }),
  )
  // Surface CUSTOM products: codes with uploaded images that aren't in ERP
  // inventory (added ahead of inventory sync via the "নতুন প্রোডাক্ট" button).
  const coveredCodes = new Set<string>()
  for (const g of out) for (const m of g.members) coveredCodes.add(m)
  const customCodes = Array.from(countByCode.entries()).filter(
    ([code, count]) => count > 0 && !coveredCodes.has(code),
  )
  const customGroups = await Promise.all(
    customCodes.map(async ([code, count]) => ({
      code,
      name: code,
      category: 'কাস্টম',
      kind: 'sku' as const,
      members: [code],
      imageCount: count,
      hasImages: true,
      primaryImageUrl: await getPrimaryImageUrl(code, business).catch(() => null),
    })),
  )
  out.push(...customGroups)

  out.sort((a, b) => Number(a.hasImages) - Number(b.hasImages) || a.code.localeCompare(b.code))

  return {
    groups: out,
    totalGroups: out.length,
    withImages: out.filter((g) => g.hasImages).length,
    missing: out.filter((g) => !g.hasImages).length,
  }
}

export async function catalogStatus(business = DEFAULT_CATALOG_BUSINESS) {
  const { loadCatalogStock, getRecentSalesSkus } = await import('@/agent/lib/catalog/inventory-lookup')
  const [stock, withImagesRows, recentSkus] = await Promise.all([
    loadCatalogStock(true),
    db.productImage.findMany({
      where: { business },
      select: { productCode: true },
      distinct: ['productCode'],
    }),
    getRecentSalesSkus(30, 100),
  ])

  const withImages = new Set(withImagesRows.map((r: { productCode: string }) => r.productCode))
  const allCodes = stock.map((s) => s.sku)
  const missing = allCodes.filter((c) => !withImages.has(c))

  const priorityMissing = recentSkus.filter((sku) => missing.includes(sku)).slice(0, 10)
  const topMissing = priorityMissing.length >= 10
    ? priorityMissing
    : [...priorityMissing, ...missing.filter((c) => !priorityMissing.includes(c))].slice(0, 10)

  return {
    business,
    totalProducts: allCodes.length,
    withImages: withImages.size,
    missingCount: missing.length,
    topMissing,
  }
}
