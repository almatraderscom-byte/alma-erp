import { serverGet } from '@/lib/server-api'
import { roundMoney } from '@/lib/money'
import { listWebsiteProducts, websiteCatalogStats } from './catalog.service'
import { getWebsiteSupabaseAdmin, websiteSupabaseConfigured } from './supabase-client'
import type { WebsiteProductSummary } from './types'

const THIN_CATEGORY_THRESHOLD = 5
const PRICE_MISMATCH_TOLERANCE = 1

type ErpStockItem = {
  sku: string
  product: string
  category?: string
  sell_price?: number
  price?: number
  current_stock?: number
  available?: number
  stockQty?: number
}

export interface WebsiteHealthReport {
  configured: boolean
  generatedAt: string
  catalog: Awaited<ReturnType<typeof websiteCatalogStats>> | null
  unpublishedInStock: Array<{
    sku: string
    erpName: string
    erpStock: number
    erpPrice: number
    websiteSlug?: string
    websitePublished?: boolean
  }>
  liveOutOfStock: Array<{
    slug: string
    name: string
    sku: string
    webStock: number
    erpStock: number | null
  }>
  priceMismatches: Array<{
    slug: string
    name: string
    sku: string
    webPrice: number
    erpPrice: number
    delta: number
  }>
  thinCategories: Array<{ slug: string; name: string; published: number; suggestion: string }>
  missingImages: Array<{ slug: string; name: string; published: boolean }>
  missingDescriptions: Array<{ slug: string; name: string; published: boolean }>
  summary: string[]
}

async function loadErpInventory(): Promise<ErpStockItem[]> {
  const data = await serverGet<{ items?: ErpStockItem[]; products?: ErpStockItem[] }>('stock', {}, 0)
  return data.items ?? data.products ?? []
}

function erpPrice(item: ErpStockItem): number {
  return roundMoney(Number(item.sell_price ?? item.price ?? 0))
}

function erpStock(item: ErpStockItem): number {
  return Number(item.current_stock ?? item.available ?? item.stockQty ?? 0)
}

function normalizeSku(sku: string): string {
  return sku.trim().toLowerCase()
}

async function loadPublishedWithoutDescription(): Promise<Array<{ slug: string; title: string }>> {
  const sb = getWebsiteSupabaseAdmin()
  const { data, error } = await sb
    .from('products')
    .select('slug, title, description, short_description')
    .eq('published', true)
    .is('deleted_at', null)
    .limit(500)
  if (error) throw new Error(error.message)
  return (data ?? [])
    .filter((r) => !r.description && !r.short_description)
    .map((r) => ({ slug: r.slug as string, title: r.title as string }))
}

export async function getWebsiteHealth(): Promise<WebsiteHealthReport> {
  const generatedAt = new Date().toISOString()
  const empty: WebsiteHealthReport = {
    configured: websiteSupabaseConfigured(),
    generatedAt,
    catalog: null,
    unpublishedInStock: [],
    liveOutOfStock: [],
    priceMismatches: [],
    thinCategories: [],
    missingImages: [],
    missingDescriptions: [],
    summary: [],
  }

  if (!websiteSupabaseConfigured()) {
    empty.summary.push('Website Supabase not configured — set WEBSITE_SUPABASE_URL + WEBSITE_SUPABASE_SERVICE_ROLE_KEY.')
    return empty
  }

  const [catalog, webProducts, erpItems, noDesc] = await Promise.all([
    websiteCatalogStats(),
    listWebsiteProducts({ limit: 500 }),
    loadErpInventory().catch(() => [] as ErpStockItem[]),
    loadPublishedWithoutDescription().catch(() => []),
  ])

  const webBySku = new Map<string, WebsiteProductSummary>()
  for (const p of webProducts) {
    webBySku.set(normalizeSku(p.sku), p)
  }

  const erpBySku = new Map<string, ErpStockItem>()
  for (const item of erpItems) {
    if (item.sku) erpBySku.set(normalizeSku(item.sku), item)
  }

  const unpublishedInStock: WebsiteHealthReport['unpublishedInStock'] = []
  for (const item of erpItems) {
    const stock = erpStock(item)
    if (stock <= 0 || !item.sku) continue
    const web = webBySku.get(normalizeSku(item.sku))
    if (!web || !web.published) {
      unpublishedInStock.push({
        sku: item.sku,
        erpName: item.product,
        erpStock: stock,
        erpPrice: erpPrice(item),
        websiteSlug: web?.slug,
        websitePublished: web?.published ?? false,
      })
    }
  }

  const liveOutOfStock: WebsiteHealthReport['liveOutOfStock'] = []
  const priceMismatches: WebsiteHealthReport['priceMismatches'] = []
  const missingImages: WebsiteHealthReport['missingImages'] = []

  for (const web of webProducts.filter((p) => p.published)) {
    if (web.stock <= 0) {
      const erp = erpBySku.get(normalizeSku(web.sku))
      liveOutOfStock.push({
        slug: web.slug,
        name: web.name,
        sku: web.sku,
        webStock: web.stock,
        erpStock: erp ? erpStock(erp) : null,
      })
    }

    const erp = erpBySku.get(normalizeSku(web.sku))
    if (erp) {
      const erpP = erpPrice(erp)
      const delta = roundMoney(web.price - erpP)
      if (erpP > 0 && Math.abs(delta) > PRICE_MISMATCH_TOLERANCE) {
        priceMismatches.push({
          slug: web.slug,
          name: web.name,
          sku: web.sku,
          webPrice: web.price,
          erpPrice: erpP,
          delta,
        })
      }
    }

    if (web.imageCount === 0) {
      missingImages.push({ slug: web.slug, name: web.name, published: true })
    }
  }

  const thinCategories = catalog.byCategory
    .filter((c) => c.published <= THIN_CATEGORY_THRESHOLD)
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      published: c.published,
      suggestion:
        c.published === 0
          ? `${c.name} ক্যাটাগরি খালি — ERP স্টক থেকে publish করার সুযোগ আছে।`
          : `${c.name}-এ মাত্র ${c.published}টি live — আরও যোগ করা যায়।`,
    }))

  const missingDescriptions = noDesc.map((r) => ({
    slug: r.slug,
    name: r.title,
    published: true,
  }))

  const summary: string[] = []
  if (unpublishedInStock.length) {
    summary.push(`${unpublishedInStock.length}টি ERP স্টকে আছে কিন্তু website-এ publish হয়নি।`)
  }
  if (liveOutOfStock.length) {
    summary.push(`${liveOutOfStock.length}টি live প্রোডাক্ট website-এ out-of-stock (oversell ঝুঁকি)।`)
  }
  if (priceMismatches.length) {
    summary.push(`${priceMismatches.length}টি price mismatch (web ≠ ERP)।`)
  }
  if (thinCategories.length) {
    summary.push(`${thinCategories.length}টি thin category — Electronics/Home Decor ইত্যাদি চেক করুন।`)
  }
  if (missingImages.length) {
    summary.push(`${missingImages.length}টি published প্রোডাক্টে web image নেই।`)
  }
  if (missingDescriptions.length) {
    summary.push(`${missingDescriptions.length}টি published প্রোডাক্টে description নেই।`)
  }
  if (!summary.length) {
    summary.push('কোনো বড় gap পাওয়া যায়নি — catalog ও ERP মোটামুটি মিলে আছে।')
  }

  return {
    configured: true,
    generatedAt,
    catalog,
    unpublishedInStock: unpublishedInStock.slice(0, 30),
    liveOutOfStock: liveOutOfStock.slice(0, 30),
    priceMismatches: priceMismatches.slice(0, 30),
    thinCategories,
    missingImages: missingImages.slice(0, 20),
    missingDescriptions: missingDescriptions.slice(0, 20),
    summary,
  }
}
