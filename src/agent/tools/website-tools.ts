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
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
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
      slugOrId: { type: 'string', description: 'Product slug or UUID on almatraders.com' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
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
      slugOrId: { type: 'string', description: 'Product slug or UUID on almatraders.com' },
      featured: { type: 'boolean', description: 'true = feature on homepage, false = remove' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
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
      slugOrId: { type: 'string', description: 'Product slug or UUID on almatraders.com' },
      priceBdt: { type: 'number', description: 'New web price in BDT (whole taka)' },
      description: { type: 'string', description: 'New full product description (Bangla)' },
      shortDescription: { type: 'string', description: 'New short description shown in listings' },
      category: {
        type: 'string',
        description: 'Category slug: panjabi, electronics, accessories, home-decor, islamic',
      },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
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

/** Longest a before/after value may run on the card before it is cut. */
const CARD_VALUE_MAX = 90

function forCard(value: unknown): string {
  if (value == null || value === '') return '(খালি)'
  const text = typeof value === 'string' ? value.trim() : String(value)
  return text.length > CARD_VALUE_MAX ? `${text.slice(0, CARD_VALUE_MAX)}…` : text
}

const edit_storefront_product: AgentTool = {
  name: 'edit_storefront_product',
  description:
    'Edit one product on almatraders.com — title, short description (meta), description, price, category, '
    + 'image alt-text, publish/unpublish, featured — ALL IN ONE approval card instead of one card per field. '
    + 'Use this whenever Boss asks to change more than one thing about a product, and prefer it over '
    + 'update_product_web / publish_product / set_product_featured. Send only the fields that should change; '
    + 'a value identical to the current one is dropped, not asked about. After approval every field is read back '
    + 'from the live site and the true value is reported. Does NOT change the URL (slug) — that is change_product_slug.',
  input_schema: {
    type: 'object' as const,
    properties: {
      slugOrId: { type: 'string', description: 'The product — its current slug or UUID.' },
      title: { type: 'string', description: 'Product name as shown on the page and in Google (10–70 characters reads best).' },
      shortDescription: { type: 'string', description: 'Meta description / listing blurb, Bangla, 50–160 characters.' },
      description: { type: 'string', description: 'Full product description, Bangla.' },
      priceBdt: { type: 'number', description: 'Web price in whole taka.' },
      category: { type: 'string', description: 'Category slug: panjabi, electronics, accessories, home-decor, islamic.' },
      published: { type: 'boolean', description: 'true = live on the storefront, false = hidden.' },
      featured: { type: 'boolean', description: 'true = show on the homepage featured row.' },
      imageAlts: {
        type: 'array',
        description: 'Alt text per image. Each url must be one of this product’s exact image URLs.',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Exact image URL from the product.' },
            alt: { type: 'string', description: 'Bangla alt text, 5–125 characters.' },
          },
          required: ['url', 'alt'],
        },
      },
      reason: { type: 'string', description: 'Why, in one line — shown to Boss on the card.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['slugOrId'],
  },
  handler: async (input) => {
    if (!websiteSupabaseConfigured()) {
      return { success: false, error: 'Website Supabase not configured.' }
    }
    try {
      const resolved = await resolveProduct(String(input.slugOrId ?? '').trim())
      if ('error' in resolved) return { success: false, error: resolved.error }
      const { product } = resolved

      const changes: Record<string, { before: unknown; after: unknown }> = {}
      const fields: Record<string, unknown> = {}
      /** What the live row must say once this is applied — the verification list. */
      const expected: Record<string, unknown> = {}
      const unchanged: string[] = []

      if (input.title != null) {
        const title = String(input.title).trim()
        if (title.length < 3 || title.length > 120) {
          return { success: false, error: `title ${title.length} অক্ষর — ৩ থেকে ১২০-এর মধ্যে রাখুন।` }
        }
        if (title === product.name) unchanged.push('title')
        else {
          changes.title = { before: product.name, after: title }
          fields.title = title
          expected.title = title
        }
      }

      if (input.shortDescription != null) {
        const short = String(input.shortDescription).trim()
        if (short.length < 20 || short.length > 300) {
          return { success: false, error: `shortDescription ${short.length} অক্ষর — ২০ থেকে ৩০০-এর মধ্যে রাখুন।` }
        }
        if (short === product.shortDescription) unchanged.push('shortDescription')
        else {
          changes.shortDescription = { before: product.shortDescription, after: short }
          fields.shortDescription = short
          expected.shortDescription = short
        }
      }

      if (input.description != null) {
        const desc = String(input.description).trim()
        if (desc.length < 30) {
          return { success: false, error: `description ${desc.length} অক্ষর — অন্তত ৩০ অক্ষর লিখুন।` }
        }
        if (desc === product.description) unchanged.push('description')
        else {
          changes.description = { before: product.description, after: desc }
          fields.description = desc
          expected.description = desc
        }
      }

      if (input.priceBdt != null) {
        const price = roundMoney(Number(input.priceBdt))
        if (!Number.isFinite(price) || price <= 0) {
          return { success: false, error: 'দাম ০-এর বেশি হতে হবে।' }
        }
        if (price === product.price) unchanged.push('priceBdt')
        else {
          changes.priceBdt = { before: product.price, after: price }
          fields.priceBdt = price
          expected.priceBdt = price
        }
      }

      if (input.category != null) {
        const catSlug = String(input.category).trim()
        if (catSlug === product.category) unchanged.push('category')
        else {
          const categoryId = await getWebsiteCategoryIdBySlug(catSlug)
          if (!categoryId) return { success: false, error: `Unknown category slug: ${catSlug}` }
          changes.category = { before: product.category, after: catSlug }
          fields.categoryId = categoryId
          expected.category = catSlug
        }
      }

      let publishTo: boolean | null = null
      if (input.published != null) {
        const want = input.published === true
        if (want === product.published) unchanged.push('published')
        else {
          publishTo = want
          changes.published = { before: product.published, after: want }
          expected.published = want
        }
      }

      let featuredTo: boolean | null = null
      if (input.featured != null) {
        const want = input.featured === true
        if (want === product.featured) unchanged.push('featured')
        else {
          featuredTo = want
          changes.featured = { before: product.featured, after: want }
          expected.featured = want
        }
      }

      const imageAlts: Array<{ url: string; alt: string }> = []
      if (Array.isArray(input.imageAlts)) {
        const known = new Map(product.images.map((img) => [img.url, img.alt]))
        for (const raw of input.imageAlts as Array<{ url?: unknown; alt?: unknown }>) {
          const url = String(raw?.url ?? '').trim()
          const alt = String(raw?.alt ?? '').trim()
          if (!known.has(url)) {
            // A placeholder URL would write alt text onto nothing and report success.
            return {
              success: false,
              error: `এই ছবিটা এই পণ্যের নয়: ${url || '(খালি)'} — audit_product_seo বা get_website_catalog থেকে হুবহু URL নিন।`,
            }
          }
          if (alt.length < 5 || alt.length > 125) {
            return { success: false, error: `alt-text ${alt.length} অক্ষর — ৫ থেকে ১২৫-এর মধ্যে রাখুন (${url})।` }
          }
          if (alt === known.get(url)) continue
          imageAlts.push({ url, alt })
        }
        if (!imageAlts.length && (input.imageAlts as unknown[]).length) unchanged.push('imageAlts')
      }

      if (!Object.keys(changes).length && !imageAlts.length) {
        const already = unchanged.length ? ` (${unchanged.join(', ')} আগে থেকেই এমনই আছে)` : ''
        return {
          success: false,
          error: `বদলানোর মতো কিছু নেই${already} — অন্তত একটা ফিল্ড দিন যেটা এখনকার মান থেকে আলাদা।`,
        }
      }

      const reason = input.reason ? String(input.reason).trim().slice(0, 200) : null

      const changeLines = Object.entries(changes)
        .map(([field, v]) => `• ${field}: ${forCard(v.before)} → ${forCard(v.after)}`)
        .join('\n')
      const altLine = imageAlts.length ? `• ছবির alt-text: ${imageAlts.length}টি ছবিতে\n` : ''

      const summary =
        `🛍️ পণ্য এডিট — ${product.name}\n`
        + `/products/${product.slug}\n`
        + `${changeLines}${changeLines ? '\n' : ''}${altLine}`
        + (unchanged.length ? `(অপরিবর্তিত: ${unchanged.join(', ')})\n` : '')
        + (reason ? `কারণ: ${reason}\n` : '')
        + `\n✅ approve করলে সব একসাথে বসবে, তারপর সাইট থেকে পড়ে মিলিয়ে দেখানো হবে।\n`
        + `⚠️ ISR/cache — live page-এ দেখতে কিছুক্ষণ লাগতে পারে।`

      const pendingActionId = await createWebsitePendingAction({
        type: 'website_edit_product',
        summary,
        conversationId: input.conversationId ? String(input.conversationId) : undefined,
        payload: {
          productId: product.id,
          slug: product.slug,
          fields,
          imageAlts,
          publishTo,
          featuredTo,
          changes,
          expected,
          reason,
          conversationId: input.conversationId ?? null,
        },
      })

      return {
        success: true,
        data: {
          pendingActionId,
          slug: product.slug,
          changedFields: Object.keys(changes),
          imageAltCount: imageAlts.length,
          unchangedFields: unchanged,
          message: `${Object.keys(changes).length + (imageAlts.length ? 1 : 0)}টি পরিবর্তনের একটাই approval card পাঠানো হয়েছে।`,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
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
  edit_storefront_product,
]

export const WEBSITE_ROLE_PROMPT = `
## WEBSITE (almatraders.com)
You can read and research the live website catalog (Supabase tables the storefront uses) and propose owner-approved changes.
- Research with get_website_catalog / get_website_health / fetch_website_page before website work.
- Surface gaps: products in stock but not published, live-but-out-of-stock, price mismatches, thin categories (e.g. Electronics, Home & Decor), missing images.
- Keep website ↔ ERP consistent (stock, price).
- ALL website changes (publish, feature, price, description) require owner approval via a confirmation card — NEVER auto-change a live public page. Show before→after.
- **Changing an existing product: use \`edit_storefront_product\`.** It takes name, short description (meta), description, price, category, image alt-text, published and featured together and stages ONE card — instead of making Boss approve a separate card per field. Send only the fields that change. After approval every field is read back from the live site, so report the live value, never "হয়ে গেছে" on your own. The URL (slug) is not editable here — that is \`change_product_slug\`, which writes the 301 redirect alongside the rename.
Source of truth: ERP inventory for stock; website catalog for what's published. When they disagree, flag it.
`.trim()
