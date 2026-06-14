import { prisma } from '@/lib/prisma'
import { formatMoneyBDT, roundMoney } from '@/lib/money'
import { listWebsiteProducts, getWebsiteProduct, websiteCatalogStats } from '@/lib/website/catalog.service'
import { getWebsiteHealth } from '@/lib/website/consistency'
import { htmlToReadableText } from '@/lib/website/html-text'
import { websiteSupabaseConfigured } from '@/lib/website/supabase-client'
import { getWebsiteCategoryIdBySlug } from '@/lib/website/write.service'
import type { AgentTool } from './registry'

const WEBSITE_BASE = 'https://www.almatraders.com'
const VALID_PATH_RE = /^\/[a-zA-Z0-9/_?=&%.-]*$/

async function createWebsitePendingAction(input: {
  type: string
  summary: string
  payload: Record<string, unknown>
  conversationId?: string
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const action = await (prisma as any).agentPendingAction.create({
    data: {
      conversationId: input.conversationId ?? null,
      type: input.type,
      payload: input.payload,
      summary: input.summary,
      costEstimate: 0,
      status: 'pending',
    },
  })
  return action.id as string
}

const fetch_website_page: AgentTool = {
  name: 'fetch_website_page',
  description:
    'Fetch a page from the ALMA website (almatraders.com) to research what is actually live — a product page, ' +
    'a category listing, the homepage, FAQ, etc. Use to verify what customers see, check a product is live, ' +
    'or research gaps. Returns readable page content.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'e.g. "/products?category=panjabi" or "/products/silk-premium-panjabi"',
      },
    },
    required: ['path'],
  },
  handler: async (input) => {
    const path = String(input.path ?? '').trim()
    if (!path.startsWith('/')) {
      return { success: false, error: 'invalid path — must start with /' }
    }
    if (!VALID_PATH_RE.test(path)) {
      return { success: false, error: 'invalid path — only almatraders.com relative paths allowed' }
    }
    if (/^https?:\/\//i.test(path)) {
      return { success: false, error: 'invalid path — absolute/external URLs rejected' }
    }

    const url = `${WEBSITE_BASE}${path}`
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'ALMA-Agent/1.0' },
        signal: AbortSignal.timeout(15_000),
      })
      const html = await res.text()
      const content = htmlToReadableText(html)
      return {
        success: true,
        data: { url, status: res.status, content },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_website_catalog: AgentTool = {
  name: 'get_website_catalog',
  description:
    'Lists the live almatraders.com product catalog from Supabase (published/draft, categories, featured). ' +
    'Use for "website e ki ache" or before publish/price work. Source of truth for what is on the public site.',
  input_schema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        description: 'Filter: panjabi, electronics, accessories, home-decor, islamic',
      },
      publishedOnly: { type: 'boolean', description: 'If true, only live/published products' },
      limit: { type: 'number', description: 'Max products (default 50)' },
      includeStats: { type: 'boolean', description: 'Include per-category counts and gaps summary' },
    },
  },
  handler: async (input) => {
    if (!websiteSupabaseConfigured()) {
      return {
        success: false,
        error: 'Website Supabase not configured (WEBSITE_SUPABASE_URL + WEBSITE_SUPABASE_SERVICE_ROLE_KEY).',
      }
    }
    try {
      const products = await listWebsiteProducts({
        category: input.category ? String(input.category) : undefined,
        publishedOnly: input.publishedOnly === true,
        limit: Number(input.limit ?? 50),
      })
      const stats = input.includeStats !== false ? await websiteCatalogStats() : null
      return {
        success: true,
        data: {
          count: products.length,
          products,
          stats,
          note: 'Stock on website = sum of product_variants.stock_quantity. ERP GAS stock may differ — use get_website_health.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_website_health: AgentTool = {
  name: 'get_website_health',
  description:
    'Compares the live website catalog with ERP inventory and surfaces gaps: products not published, ' +
    'live-but-out-of-stock, price mismatches, thin categories, missing images. Use for "website e ki ki thik nai", ' +
    'website review, or before a publish plan.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const report = await getWebsiteHealth()
      return { success: true, data: report }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

async function resolveProduct(slugOrId: string) {
  const product = await getWebsiteProduct(slugOrId)
  if (!product) return { error: `Product not found: ${slugOrId}` }
  return { product }
}

const publish_product: AgentTool = {
  name: 'publish_product',
  description:
    'Propose publishing a product on almatraders.com (sets published=true). Creates a PENDING confirmation card — ' +
    'owner must Approve before any live change. NEVER auto-publish.',
  input_schema: {
    type: 'object' as const,
    properties: {
      slugOrId: { type: 'string', description: 'Product slug or UUID' },
      conversationId: { type: 'string' },
    },
    required: ['slugOrId'],
  },
  handler: async (input) => {
    if (!websiteSupabaseConfigured()) {
      return { success: false, error: 'Website Supabase not configured.' }
    }
    try {
      const resolved = await resolveProduct(String(input.slugOrId))
      if ('error' in resolved) return { success: false, error: resolved.error }
      const { product } = resolved
      if (product.published) {
        return { success: false, error: `${product.slug} ইতোমধ্যে published।` }
      }

      const summary =
        `🌐 Website PUBLISH\n` +
        `${product.name} (${product.slug})\n` +
        `SKU: ${product.sku} · ${formatMoneyBDT(product.price)} · ${product.category}\n` +
        `Before: draft (published=false)\n` +
        `After: LIVE on almatraders.com\n` +
        `⚠️ ISR/cache — পেজে দেখতে কিছুক্ষণ লাগতে পারে।`

      const pendingActionId = await createWebsitePendingAction({
        type: 'website_publish',
        summary,
        conversationId: input.conversationId ? String(input.conversationId) : undefined,
        payload: {
          productId: product.id,
          slug: product.slug,
          before: { published: false },
          after: { published: true },
          conversationId: input.conversationId ?? null,
        },
      })

      return {
        success: true,
        data: {
          pendingActionId,
          summary,
          message: 'Publish request created — owner Approve required. No live change yet.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const unpublish_product: AgentTool = {
  name: 'unpublish_product',
  description:
    'Propose unpublishing a product from almatraders.com (published=false). PENDING confirmation — owner Approve required.',
  input_schema: {
    type: 'object' as const,
    properties: {
      slugOrId: { type: 'string' },
      conversationId: { type: 'string' },
    },
    required: ['slugOrId'],
  },
  handler: async (input) => {
    if (!websiteSupabaseConfigured()) {
      return { success: false, error: 'Website Supabase not configured.' }
    }
    try {
      const resolved = await resolveProduct(String(input.slugOrId))
      if ('error' in resolved) return { success: false, error: resolved.error }
      const { product } = resolved
      if (!product.published) {
        return { success: false, error: `${product.slug} ইতোমধ্যে unpublished।` }
      }

      const summary =
        `🌐 Website UNPUBLISH\n` +
        `${product.name} (${product.slug})\n` +
        `Before: LIVE (published=true)\n` +
        `After: hidden from storefront\n` +
        `⚠️ ISR/cache — সাইটে আপডেট দেখতে কিছুক্ষণ লাগতে পারে।`

      const pendingActionId = await createWebsitePendingAction({
        type: 'website_unpublish',
        summary,
        conversationId: input.conversationId ? String(input.conversationId) : undefined,
        payload: {
          productId: product.id,
          slug: product.slug,
          before: { published: true },
          after: { published: false },
          conversationId: input.conversationId ?? null,
        },
      })

      return {
        success: true,
        data: { pendingActionId, summary, message: 'Unpublish request created — awaiting owner Approve.' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const set_product_featured: AgentTool = {
  name: 'set_product_featured',
  description:
    'Propose adding/removing a product from the homepage featured section (site_config). PENDING confirmation — owner Approve required.',
  input_schema: {
    type: 'object' as const,
    properties: {
      slugOrId: { type: 'string' },
      featured: { type: 'boolean', description: 'true = feature on homepage, false = remove' },
      conversationId: { type: 'string' },
    },
    required: ['slugOrId', 'featured'],
  },
  handler: async (input) => {
    if (!websiteSupabaseConfigured()) {
      return { success: false, error: 'Website Supabase not configured.' }
    }
    try {
      const featured = input.featured === true
      const resolved = await resolveProduct(String(input.slugOrId))
      if ('error' in resolved) return { success: false, error: resolved.error }
      const { product } = resolved

      const summary =
        `🌐 Website FEATURED ${featured ? 'ON' : 'OFF'}\n` +
        `${product.name} (${product.slug})\n` +
        `Before: featured=${product.featured}\n` +
        `After: featured=${featured} (homepage manual list)\n` +
        `⚠️ Homepage cache/ISR — পরিবর্তন দেখতে কিছুক্ষণ লাগতে পারে।`

      const pendingActionId = await createWebsitePendingAction({
        type: 'website_set_featured',
        summary,
        conversationId: input.conversationId ? String(input.conversationId) : undefined,
        payload: {
          productId: product.id,
          slug: product.slug,
          featured,
          before: { featured: product.featured },
          after: { featured },
          conversationId: input.conversationId ?? null,
        },
      })

      return {
        success: true,
        data: { pendingActionId, summary, message: 'Featured change pending — owner Approve required.' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const update_product_web: AgentTool = {
  name: 'update_product_web',
  description:
    'Propose updating web fields (price_bdt, description, category) on almatraders.com. Shows before→after in confirmation card. PENDING — owner Approve required. NEVER auto-change price.',
  input_schema: {
    type: 'object' as const,
    properties: {
      slugOrId: { type: 'string' },
      priceBdt: { type: 'number', description: 'New web price in BDT (whole taka)' },
      description: { type: 'string' },
      shortDescription: { type: 'string' },
      category: {
        type: 'string',
        description: 'Category slug: panjabi, electronics, accessories, home-decor, islamic',
      },
      conversationId: { type: 'string' },
    },
    required: ['slugOrId'],
  },
  handler: async (input) => {
    if (!websiteSupabaseConfigured()) {
      return { success: false, error: 'Website Supabase not configured.' }
    }
    try {
      const resolved = await resolveProduct(String(input.slugOrId))
      if ('error' in resolved) return { success: false, error: resolved.error }
      const { product } = resolved

      const changes: Record<string, { before: unknown; after: unknown }> = {}
      const fields: Record<string, unknown> = {}

      if (input.priceBdt != null) {
        const price = roundMoney(Number(input.priceBdt))
        changes.priceBdt = { before: product.price, after: price }
        fields.priceBdt = price
      }
      if (input.description != null) {
        changes.description = { before: product.description?.slice(0, 80) ?? null, after: String(input.description).slice(0, 80) }
        fields.description = String(input.description)
      }
      if (input.shortDescription != null) {
        changes.shortDescription = {
          before: product.shortDescription?.slice(0, 80) ?? null,
          after: String(input.shortDescription).slice(0, 80),
        }
        fields.shortDescription = String(input.shortDescription)
      }
      if (input.category != null) {
        const catSlug = String(input.category)
        const categoryId = await getWebsiteCategoryIdBySlug(catSlug)
        if (!categoryId) return { success: false, error: `Unknown category slug: ${catSlug}` }
        changes.category = { before: product.category, after: catSlug }
        fields.categoryId = categoryId
        fields.categorySlug = catSlug
      }

      if (!Object.keys(changes).length) {
        return { success: false, error: 'No fields to update — provide priceBdt, description, shortDescription, or category.' }
      }

      const changeLines = Object.entries(changes)
        .map(([k, v]) => `${k}: ${JSON.stringify(v.before)} → ${JSON.stringify(v.after)}`)
        .join('\n')

      const summary =
        `🌐 Website UPDATE\n` +
        `${product.name} (${product.slug})\n` +
        `${changeLines}\n` +
        `⚠️ ISR/cache — live page আপডেট দেখতে কিছুক্ষণ লাগতে পারে।`

      const pendingActionId = await createWebsitePendingAction({
        type: 'website_update_product',
        summary,
        conversationId: input.conversationId ? String(input.conversationId) : undefined,
        payload: {
          productId: product.id,
          slug: product.slug,
          fields,
          changes,
          conversationId: input.conversationId ?? null,
        },
      })

      return {
        success: true,
        data: { pendingActionId, summary, changes, message: 'Web update pending — owner Approve required.' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const WEBSITE_TOOLS: AgentTool[] = [
  fetch_website_page,
  get_website_catalog,
  get_website_health,
  publish_product,
  unpublish_product,
  set_product_featured,
  update_product_web,
]

export const WEBSITE_ROLE_PROMPT = `
## WEBSITE (almatraders.com)
You can read and research the live website catalog (Supabase tables the storefront uses) and propose owner-approved changes.
- Research with get_website_catalog / get_website_health / fetch_website_page before website work.
- Surface gaps: products in stock but not published, live-but-out-of-stock, price mismatches, thin categories (e.g. Electronics, Home & Decor), missing images.
- Keep website ↔ ERP consistent (stock, price).
- ALL website changes (publish, feature, price, description) require owner approval via a confirmation card — NEVER auto-change a live public page. Show before→after.
Source of truth: ERP inventory for stock; website catalog for what's published. When they disagree, flag it.
`.trim()
