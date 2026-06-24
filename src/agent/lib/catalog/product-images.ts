import { prisma } from '@/lib/prisma'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'
import {
  DEFAULT_CATALOG_BUSINESS,
  normalizeProductCode,
  resolveProductInput,
} from '@/agent/lib/catalog/inventory-lookup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export function businessStorageSlug(business: string): string {
  return business.toLowerCase().replace(/_/g, '-')
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

export type ProductImageEntry = {
  url: string | null
  storagePath: string
  isPrimary: boolean
}

/**
 * Returns ALL images for a product code (not just the primary), primary first.
 * Re-signs storage URLs on the fly when the stored URL is missing/expired so the
 * agent (and CS) always receive a usable link. Limited to `limit` images.
 */
export async function listProductImages(
  productCode: string,
  business = DEFAULT_CATALOG_BUSINESS,
  limit = 8,
): Promise<ProductImageEntry[]> {
  const code = normalizeProductCode(productCode)
  const rows = await db.productImage.findMany({
    where: { productCode: code, business },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    take: limit,
  })
  const out: ProductImageEntry[] = []
  for (const row of rows as Array<{ url: string | null; storagePath: string; isPrimary: boolean }>) {
    let url = row.url
    if (!url) {
      try {
        url = await agentStorageSignedUrl(row.storagePath, 86400)
      } catch {
        url = null
      }
    }
    out.push({ url, storagePath: row.storagePath, isPrimary: Boolean(row.isPrimary) })
  }
  return out
}

export async function getPrimaryImageUrl(productCode: string, business = DEFAULT_CATALOG_BUSINESS): Promise<string | null> {
  const code = normalizeProductCode(productCode)
  const row = await db.productImage.findFirst({
    where: { productCode: code, business },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  })
  if (!row) return null
  if (row.url) return row.url
  try {
    return await agentStorageSignedUrl(row.storagePath, 3600)
  } catch {
    return null
  }
}

export async function deleteImagesForCode(productCode: string, business = DEFAULT_CATALOG_BUSINESS) {
  const code = normalizeProductCode(productCode)
  const deleted = await db.productImage.deleteMany({ where: { productCode: code, business } })
  return { code, deleted: deleted.count }
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
