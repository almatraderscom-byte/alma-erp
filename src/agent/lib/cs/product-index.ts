/**
 * Product visual index — Gemini describe + OpenAI embed + pgvector search.
 */
import { prisma } from '@/lib/prisma'
import { embed, vectorLiteral } from '@/agent/lib/embeddings'
import { describeProductImage } from '@/agent/lib/cs/gemini-vision'
import { getPrimaryImageUrl } from '@/agent/lib/catalog/product-images'
import { agentStorageDownload } from '@/agent/lib/storage'
import {
  DEFAULT_CATALOG_BUSINESS,
  loadCatalogStock,
  normalizeProductCode,
} from '@/agent/lib/catalog/inventory-lookup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type IndexCandidate = {
  productCode: string
  business: string
  description: string
  tags: Record<string, unknown>
  imageUrl: string | null
  score: number
}

export async function indexProductVisual(productCode: string, business = DEFAULT_CATALOG_BUSINESS): Promise<boolean> {
  const code = normalizeProductCode(productCode)
  const imageUrl = await getPrimaryImageUrl(code, business)
  if (!imageUrl) return false

  let buffer: Buffer
  let mimeType = 'image/jpeg'
  const imgRow = await db.productImage.findFirst({
    where: { productCode: code, business },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  })
  if (imgRow?.storagePath) {
    buffer = await agentStorageDownload(imgRow.storagePath)
  } else {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return false
    buffer = Buffer.from(await res.arrayBuffer())
    mimeType = res.headers.get('content-type') ?? 'image/jpeg'
  }

  const vision = await describeProductImage(buffer.toString('base64'), mimeType)
  const emb = await embed(vision.combinedText)
  if (!emb.success) return false

  const vec = vectorLiteral(emb.data)
  await db.$executeRawUnsafe(
    `INSERT INTO product_visual_index (id, product_code, business, image_url, storage_path, description, tags, embedding, indexed_at, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::jsonb, $7::vector, NOW(), NOW(), NOW())
     ON CONFLICT (product_code, business)
     DO UPDATE SET image_url = EXCLUDED.image_url, storage_path = EXCLUDED.storage_path,
                   description = EXCLUDED.description, tags = EXCLUDED.tags,
                   embedding = EXCLUDED.embedding, indexed_at = NOW(), updated_at = NOW()`,
    code,
    business,
    imageUrl,
    imgRow?.storagePath ?? null,
    vision.combinedText,
    JSON.stringify(vision.tags),
    vec,
  )
  return true
}

export async function searchVisualIndexFromImage(
  imageB64: string,
  mimeType: string,
  limit = 5,
  business = DEFAULT_CATALOG_BUSINESS,
): Promise<IndexCandidate[]> {
  const vision = await describeProductImage(imageB64, mimeType)
  return searchVisualIndex(vision.combinedText, limit, business)
}

export async function searchVisualIndex(
  queryText: string,
  limit = 5,
  business = DEFAULT_CATALOG_BUSINESS,
): Promise<IndexCandidate[]> {
  const emb = await embed(queryText)
  if (!emb.success) return []

  const vec = vectorLiteral(emb.data)
  const rows: Array<{
    product_code: string
    business: string
    description: string
    tags: Record<string, unknown>
    image_url: string | null
    score: number
  }> = await db.$queryRawUnsafe(
    `SELECT product_code, business, description, tags, image_url,
            1 - (embedding <=> $1::vector) AS score
     FROM product_visual_index
     WHERE embedding IS NOT NULL AND business = $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    vec,
    business,
    limit,
  )

  return rows.map((r) => ({
    productCode: r.product_code,
    business: r.business,
    description: r.description,
    tags: r.tags ?? {},
    imageUrl: r.image_url,
    score: Number(r.score),
  }))
}

export async function runFullProductIndex(business = DEFAULT_CATALOG_BUSINESS): Promise<{
  indexed: number
  failed: number
  skippedNoImage: number
  total: number
  missingByBusiness: Record<string, number>
}> {
  const status = await import('@/agent/lib/catalog/product-images').then((m) => m.catalogStatus(business))
  const withImages = new Set<string>()
  const imgRows = await db.productImage.findMany({
    where: { business },
    select: { productCode: true },
    distinct: ['productCode'],
  })
  for (const r of imgRows) withImages.add(r.productCode)

  let indexed = 0
  let failed = 0
  const stock = await loadCatalogStock(true)
  for (const row of stock) {
    if (!withImages.has(row.sku)) continue
    try {
      const ok = await indexProductVisual(row.sku, business)
      if (ok) indexed++
    } catch (err) {
      failed++
      console.warn(`[product-index] skip ${row.sku}:`, err instanceof Error ? err.message : err)
    }
  }

  return {
    indexed,
    failed,
    skippedNoImage: status.missingCount,
    total: status.totalProducts,
    missingByBusiness: { [business]: status.missingCount },
  }
}
