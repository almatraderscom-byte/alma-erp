import { roundMoney } from '@/lib/money'
import { getWebsiteSupabaseAdmin, websiteSupabaseConfigured } from './supabase-client'
import type {
  WebsiteCategoryRow,
  WebsiteProductDetail,
  WebsiteProductRow,
  WebsiteProductSummary,
  WebsiteCatalogStats,
} from './types'

const PRODUCT_SELECT = `
  id, category_id, sku, slug, title, product_type, design_group_id, design_group_name,
  short_description, description, price_bdt, compare_at_price_bdt,
  published, published_at, deleted_at, created_at, updated_at,
  categories ( id, slug, name ),
  product_images ( id, url, alt_text, sort_order ),
  product_variants ( id, sku, size, color, stock_quantity )
`

const PANJABI_TYPES = new Set(['men_panjabi', 'boy_panjabi', 'women_three_piece', 'girl_two_piece'])

function categoryFromRow(row: WebsiteProductRow): WebsiteCategoryRow | null {
  const c = row.categories
  if (!c) return null
  return Array.isArray(c) ? c[0] ?? null : c
}

function variantStock(row: WebsiteProductRow): number {
  return (row.product_variants ?? []).reduce((sum, v) => sum + Number(v.stock_quantity ?? 0), 0)
}

function displayType(row: WebsiteProductRow): string {
  if (row.design_group_id && row.product_type && PANJABI_TYPES.has(row.product_type)) {
    return 'family-set'
  }
  return row.product_type
}

let featuredProductIdsCache: { ids: Set<string>; fetchedAt: number } | null = null
const FEATURED_CACHE_MS = 60_000

async function loadFeaturedProductIds(): Promise<Set<string>> {
  const now = Date.now()
  if (featuredProductIdsCache && now - featuredProductIdsCache.fetchedAt < FEATURED_CACHE_MS) {
    return featuredProductIdsCache.ids
  }
  const sb = getWebsiteSupabaseAdmin()
  const { data, error } = await sb.from('site_config').select('value').eq('key', 'homepage').maybeSingle()
  if (error) throw new Error(`featured config: ${error.message}`)

  const ids = new Set<string>()
  const value = data?.value as { sections?: Array<{ id: string; data?: { manualProductIds?: string[] } }> } | null
  const featured = value?.sections?.find((s) => s.id === 'featured')
  for (const id of featured?.data?.manualProductIds ?? []) {
    if (id) ids.add(id)
  }
  featuredProductIdsCache = { ids, fetchedAt: now }
  return ids
}

function mapSummary(row: WebsiteProductRow, featuredIds: Set<string>): WebsiteProductSummary {
  const cat = categoryFromRow(row)
  return {
    id: row.id,
    slug: row.slug,
    name: row.title,
    sku: row.sku,
    price: roundMoney(Number(row.price_bdt ?? 0)),
    category: cat?.slug ?? 'unknown',
    categoryLabel: cat?.name ?? 'Unknown',
    type: displayType(row),
    published: Boolean(row.published),
    featured: featuredIds.has(row.id),
    imageCount: row.product_images?.length ?? 0,
    stock: variantStock(row),
    updatedAt: row.updated_at,
  }
}

function mapDetail(row: WebsiteProductRow, featuredIds: Set<string>): WebsiteProductDetail {
  const summary = mapSummary(row, featuredIds)
  const images = [...(row.product_images ?? [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((img) => ({ url: img.url, alt: img.alt_text, sortOrder: img.sort_order }))

  return {
    ...summary,
    description: row.description,
    shortDescription: row.short_description,
    compareAtPrice: row.compare_at_price_bdt != null ? roundMoney(row.compare_at_price_bdt) : null,
    images,
    variants: (row.product_variants ?? []).map((v) => ({
      sku: v.sku,
      size: v.size,
      color: v.color,
      stock: Number(v.stock_quantity ?? 0),
    })),
    designGroupId: row.design_group_id,
    designGroupName: row.design_group_name,
  }
}

function notConfiguredError() {
  return new Error('Website catalog unavailable — WEBSITE_SUPABASE_URL and WEBSITE_SUPABASE_SERVICE_ROLE_KEY not set.')
}

/** Live website catalog — what customers actually see on almatraders.com. */
export async function listWebsiteProducts(
  opts: { category?: string; publishedOnly?: boolean; limit?: number } = {},
): Promise<WebsiteProductSummary[]> {
  if (!websiteSupabaseConfigured()) throw notConfiguredError()

  const sb = getWebsiteSupabaseAdmin()
  const limit = Math.min(opts.limit ?? 200, 500)
  let query = sb
    .from('products')
    .select(PRODUCT_SELECT)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (opts.publishedOnly) query = query.eq('published', true)

  const { data, error } = await query
  if (error) throw new Error(`listWebsiteProducts: ${error.message}`)

  const featuredIds = await loadFeaturedProductIds()
  let rows = (data ?? []) as WebsiteProductRow[]

  if (opts.category) {
    const catSlug = opts.category.toLowerCase()
    rows = rows.filter((r) => categoryFromRow(r)?.slug === catSlug)
  }

  return rows.map((r) => mapSummary(r, featuredIds))
}

export async function getWebsiteProduct(slugOrId: string): Promise<WebsiteProductDetail | null> {
  if (!websiteSupabaseConfigured()) throw notConfiguredError()

  const sb = getWebsiteSupabaseAdmin()
  const key = slugOrId.trim()
  const isUuid = /^[0-9a-f-]{36}$/i.test(key)

  let query = sb.from('products').select(PRODUCT_SELECT).is('deleted_at', null)
  query = isUuid ? query.eq('id', key) : query.eq('slug', key)

  const { data, error } = await query.maybeSingle()
  if (error) throw new Error(`getWebsiteProduct: ${error.message}`)
  if (!data) return null

  const featuredIds = await loadFeaturedProductIds()
  return mapDetail(data as WebsiteProductRow, featuredIds)
}

export async function websiteCatalogStats(): Promise<WebsiteCatalogStats> {
  if (!websiteSupabaseConfigured()) throw notConfiguredError()

  const sb = getWebsiteSupabaseAdmin()
  const { data, error } = await sb
    .from('products')
    .select(PRODUCT_SELECT)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(2000)

  if (error) throw new Error(`websiteCatalogStats: ${error.message}`)

  const featuredIds = await loadFeaturedProductIds()
  const rows = (data ?? []) as WebsiteProductRow[]
  const summaries = rows.map((r) => mapSummary(r, featuredIds))

  const byCategoryMap = new Map<string, { slug: string; name: string; published: number; draft: number; total: number }>()
  for (const p of summaries) {
    const existing = byCategoryMap.get(p.category) ?? {
      slug: p.category,
      name: p.categoryLabel,
      published: 0,
      draft: 0,
      total: 0,
    }
    existing.total += 1
    if (p.published) existing.published += 1
    else existing.draft += 1
    byCategoryMap.set(p.category, existing)
  }

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

  return {
    totalProducts: summaries.length,
    totalPublished: summaries.filter((p) => p.published).length,
    totalDraft: summaries.filter((p) => !p.published).length,
    noImageCount: summaries.filter((p) => p.imageCount === 0).length,
    recentlyAdded: summaries
      .filter((p) => new Date(p.updatedAt).getTime() >= weekAgo)
      .slice(0, 8)
      .map((p) => ({ slug: p.slug, name: p.name, createdAt: p.updatedAt })),
    recentlyUpdated: summaries
      .slice(0, 8)
      .map((p) => ({ slug: p.slug, name: p.name, updatedAt: p.updatedAt })),
    byCategory: [...byCategoryMap.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
  }
}
