import { prisma } from '@/lib/prisma'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'
import {
  DEFAULT_CATALOG_BUSINESS,
  normalizeProductCode,
  resolveProductCode,
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

export async function addProductImage(input: {
  productCode: string
  business?: string
  imageBuffer: Buffer
  uploadedByChatId?: string
  contentType?: string
}): Promise<{ ok: true; code: string; total: number; isPrimary: boolean } | { ok: false; reason: string; suggestions?: string[] }> {
  const business = input.business ?? DEFAULT_CATALOG_BUSINESS
  const resolved = await resolveProductCode(input.productCode)
  if (!resolved.ok) {
    return { ok: false, reason: 'invalid_code', suggestions: resolved.suggestions }
  }

  const code = resolved.code
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
