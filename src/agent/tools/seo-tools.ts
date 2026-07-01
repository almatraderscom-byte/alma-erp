import { prisma } from '@/lib/prisma'
import { listWebsiteProducts, getWebsiteProduct } from '@/lib/website/catalog.service'
import { websiteSupabaseConfigured } from '@/lib/website/supabase-client'
import { oxylabsSerpSearch, oxylabsConfigured, logOxylabsUsage } from '@/lib/oxylabs/client'
import { verifyOxylabsSpendApproval, consumeOxylabsApproval } from '@/agent/lib/oxylabs-approval'
import { RANK_TRACKING_MAX_KEYWORDS } from '@/agent/lib/growth/settings'
import {
  isGscConnected,
  resolveSiteUrl,
  searchAnalyticsQuery,
  listSitemaps,
  inspectUrl,
} from '@/agent/lib/gsc'
import type { WebsiteProductDetail, WebsiteProductSummary } from '@/lib/website/types'
import type { AgentTool } from './registry'

/** YYYY-MM-DD in UTC, offset by `daysAgo` days from today. */
function ymd(daysAgo: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

const GSC_NOT_CONNECTED = {
  success: false as const,
  error:
    'Google Search Console যুক্ত করা নেই। ALMA Agent → সাইডবারে 🔍 (Growth) পেজ থেকে "Google Search Console যুক্ত করুন"-এ ক্লিক করে owner একবার connect করলে real search data আসবে।',
}

type SeoIssue = { field: string; issue: string; severity: 'high' | 'medium' | 'low' }

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function auditProduct(p: WebsiteProductDetail): SeoIssue[] {
  const issues: SeoIssue[] = []

  if (!p.name || p.name.length < 10) {
    issues.push({ field: 'title', issue: `টাইটেল খুব ছোট (${p.name?.length ?? 0} chars) — SEO-friendly নাম দরকার`, severity: 'medium' })
  }
  if (p.name && p.name.length > 70) {
    issues.push({ field: 'title', issue: `টাইটেল খুব বড় (${p.name.length} chars) — search result-এ truncate হবে`, severity: 'low' })
  }

  if (!p.shortDescription || p.shortDescription.trim().length < 50) {
    issues.push({ field: 'shortDescription', issue: `Meta description নেই বা খুব ছোট (${p.shortDescription?.length ?? 0} chars) — Google snippet-এর জন্য 50-160 chars দরকার`, severity: 'high' })
  }
  if (p.shortDescription && p.shortDescription.length > 160) {
    issues.push({ field: 'shortDescription', issue: `Meta description খুব বড় (${p.shortDescription.length} chars) — 160 chars-এর বেশি Google-এ cut হয়ে যায়`, severity: 'low' })
  }

  if (!p.description || p.description.trim().length < 100) {
    issues.push({ field: 'description', issue: `Product description নেই বা খুব ছোট (${p.description?.length ?? 0} chars) — thin content, SEO-এ খারাপ`, severity: 'high' })
  }

  const missingAlt = (p.images ?? []).filter(img => !img.alt || !img.alt.trim())
  if (missingAlt.length > 0) {
    issues.push({ field: 'images', issue: `${missingAlt.length}টি ছবিতে alt text নেই — accessibility + image SEO-এর জন্য দরকার`, severity: 'medium' })
  }
  if ((p.images ?? []).length === 0) {
    issues.push({ field: 'images', issue: 'কোনো ছবি নেই', severity: 'high' })
  }

  if (!SLUG_RE.test(p.slug)) {
    issues.push({ field: 'slug', issue: `slug "${p.slug}" SEO-friendly format-এ নেই (lowercase, hyphen-separated হওয়া উচিত)`, severity: 'low' })
  }

  return issues
}

const audit_product_seo: AgentTool = {
  name: 'audit_product_seo',
  description:
    'On-page SEO audit for almatraders.com products — checks title length, meta description, product ' +
    'description completeness, image alt-text, and slug format. No external cost. Use slugOrId for one ' +
    'product, or scope="all_published"/category for a bulk scan.',
  input_schema: {
    type: 'object' as const,
    properties: {
      slugOrId: { type: 'string', description: 'Single product slug or UUID' },
      scope: { type: 'string', enum: ['all_published', 'category'], description: 'Bulk scan scope (alternative to slugOrId)' },
      category: { type: 'string', description: 'Category slug filter when scope=category' },
      limit: { type: 'number', description: 'Max products for bulk scan (default 20)' },
    },
  },
  handler: async (input) => {
    if (!websiteSupabaseConfigured()) {
      return { success: false, error: 'Website Supabase not configured.' }
    }
    try {
      if (input.slugOrId) {
        const product = await getWebsiteProduct(String(input.slugOrId))
        if (!product) return { success: false, error: `Product not found: ${input.slugOrId}` }
        const issues = auditProduct(product)
        return {
          success: true,
          data: {
            slug: product.slug,
            name: product.name,
            published: product.published,
            issueCount: issues.length,
            issues,
          },
        }
      }

      const limit = Math.min(Number(input.limit ?? 20), 50)
      const summaries: WebsiteProductSummary[] = await listWebsiteProducts({
        publishedOnly: input.scope === 'all_published' || !input.scope,
        category: input.scope === 'category' ? String(input.category ?? '') : undefined,
        limit,
      })

      const results: Array<{ slug: string; name: string; issueCount: number; topIssues: SeoIssue[] }> = []
      for (const s of summaries) {
        const detail = await getWebsiteProduct(s.slug)
        if (!detail) continue
        const issues = auditProduct(detail)
        if (issues.length > 0) {
          results.push({ slug: s.slug, name: s.name, issueCount: issues.length, topIssues: issues.slice(0, 3) })
        }
      }

      results.sort((a, b) => b.issueCount - a.issueCount)

      return {
        success: true,
        data: {
          scanned: summaries.length,
          withIssues: results.length,
          products: results.slice(0, limit),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const research_seo_keywords: AgentTool = {
  name: 'research_seo_keywords',
  description:
    'Research search rankings for a product/category keyword on Google (Bangladesh) — see what currently ' +
    'ranks for terms like "premium panjabi Dhaka" or "family matching panjabi set". Uses Oxylabs credits — ' +
    'use sparingly, only for genuine SEO/content-strategy decisions, not casual curiosity. Check if this ' +
    'exact query was already researched in this conversation before calling again. ' +
    'REQUIRES confirm_oxylabs_spend approval first, then pass spendApprovalId.',
  input_schema: {
    type: 'object' as const,
    properties: {
      keyword: { type: 'string', description: 'Search term to check rankings for, e.g. "premium panjabi Dhaka"' },
      productSlug: { type: 'string', description: 'Optional — check if almatraders.com/products/{slug} appears in results for this keyword' },
      spendApprovalId: { type: 'string', description: 'Required — from confirm_oxylabs_spend after owner approves' },
    },
    required: ['keyword', 'spendApprovalId'],
  },
  handler: async (input) => {
    if (!oxylabsConfigured()) {
      return { success: false, error: 'Oxylabs not configured (OXYLABS_API_KEY missing).' }
    }
    const conversationId = input.conversationId ? String(input.conversationId) : null
    const gate = await verifyOxylabsSpendApproval({
      approvalId: input.spendApprovalId ? String(input.spendApprovalId) : null,
      tool: 'research_seo_keywords',
      input,
      conversationId,
    })
    if (!gate.ok) {
      return { success: false, error: gate.error, data: { needsOxylabsApproval: true, estimatedCredits: gate.estimatedCredits } }
    }

    const keyword = String(input.keyword ?? '').trim()
    if (!keyword) return { success: false, error: 'keyword is required' }

    const result = await oxylabsSerpSearch(keyword, { limit: 10 })
    void logOxylabsUsage({ tool: 'research_seo_keywords', query: keyword, success: result.success })
    if (!result.success) return { success: false, error: result.error }

    const results = result.results ?? []
    let almaRank: number | null = null
    let almaUrl: string | null = null
    for (const r of results) {
      if (r.url.includes('almatraders.com')) {
        almaRank = r.pos
        almaUrl = r.url
        break
      }
    }

    let productMatch: { found: boolean; rank: number | null } | null = null
    if (input.productSlug) {
      const slug = String(input.productSlug)
      const match = results.find(r => r.url.includes(slug))
      productMatch = { found: !!match, rank: match?.pos ?? null }
    }

    await consumeOxylabsApproval(gate.approvalId)

    return {
      success: true,
      data: {
        keyword,
        top10: results.map(r => ({ rank: r.pos, url: r.url, title: r.title })),
        almatraders: almaRank !== null
          ? { rank: almaRank, url: almaUrl }
          : { rank: null, message: 'Top 10-এ almatraders.com নেই' },
        productMatch,
      },
    }
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const draft_seo_fixes: AgentTool = {
  name: 'draft_seo_fixes',
  description:
    'Package a BATCH of on-page SEO content fixes for almatraders.com products into ONE approval card. ' +
    'Workflow: first run audit_product_seo to find products with weak meta/description, then YOU draft the improved ' +
    'Bangla copy for each (meta description 50-160 chars, product description 100+ chars, keyword-rich, on-brand, ' +
    'halal-compliant), then call this with the drafts. The owner approves the whole batch at once; on approval each ' +
    'product\'s shortDescription/description is updated live. NEVER auto-apply — this only creates the pending card. ' +
    'Only shortDescription (meta) and description are writable via SEO fixes; do not attempt alt-text/slug here.',
  input_schema: {
    type: 'object' as const,
    properties: {
      fixes: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        description: 'Per-product SEO copy fixes you have drafted.',
        items: {
          type: 'object',
          properties: {
            slugOrId: { type: 'string', description: 'Product slug or UUID' },
            shortDescription: { type: 'string', description: 'New meta description, 50-160 chars, Bangla, keyword-rich.' },
            description: { type: 'string', description: 'New/expanded product description, 100+ chars.' },
          },
          required: ['slugOrId'],
        },
      },
      note: { type: 'string', description: 'Short label for this SEO batch (shown on the card).' },
      conversationId: { type: 'string' },
    },
    required: ['fixes'],
  },
  handler: async (input) => {
    if (!websiteSupabaseConfigured()) {
      return { success: false, error: 'Website Supabase not configured.' }
    }
    try {
      const rawFixes = Array.isArray(input.fixes) ? input.fixes : []
      if (rawFixes.length === 0) return { success: false, error: 'অন্তত একটা product fix দরকার।' }
      const conversationId = input.conversationId ? String(input.conversationId) : null
      const note = input.note ? String(input.note).trim() : 'SEO ফিক্স'

      const items: Array<{
        productId: string
        slug: string
        name: string
        fields: { shortDescription?: string; description?: string }
        changes: Record<string, { before: unknown; after: unknown }>
      }> = []

      for (let i = 0; i < rawFixes.length; i++) {
        const f = rawFixes[i] as Record<string, unknown>
        const slugOrId = String(f.slugOrId ?? '').trim()
        if (!slugOrId) return { success: false, error: `ফিক্স #${i + 1}: slugOrId খালি।` }
        const product = await getWebsiteProduct(slugOrId)
        if (!product) return { success: false, error: `ফিক্স #${i + 1}: product পাওয়া যায়নি (${slugOrId})।` }

        const fields: { shortDescription?: string; description?: string } = {}
        const changes: Record<string, { before: unknown; after: unknown }> = {}

        if (f.shortDescription != null) {
          const meta = String(f.shortDescription).trim()
          if (meta.length < 50 || meta.length > 160) {
            return { success: false, error: `ফিক্স #${i + 1} (${product.slug}): meta description ${meta.length} chars — 50-160-এর মধ্যে দিন।` }
          }
          fields.shortDescription = meta
          changes.shortDescription = { before: product.shortDescription?.slice(0, 80) ?? null, after: meta.slice(0, 80) }
        }
        if (f.description != null) {
          const desc = String(f.description).trim()
          if (desc.length < 100) {
            return { success: false, error: `ফিক্স #${i + 1} (${product.slug}): description ${desc.length} chars — অন্তত 100 chars দিন।` }
          }
          fields.description = desc
          changes.description = { before: product.description?.slice(0, 80) ?? null, after: desc.slice(0, 80) }
        }

        if (Object.keys(fields).length === 0) {
          return { success: false, error: `ফিক্স #${i + 1} (${product.slug}): shortDescription বা description অন্তত একটা দিন।` }
        }
        items.push({ productId: product.id, slug: product.slug, name: product.name, fields, changes })
      }

      const lines = items.map((it) => {
        const parts = Object.keys(it.changes).map((k) => (k === 'shortDescription' ? 'meta' : k))
        return `• ${it.name} (${it.slug}) — ${parts.join(', ')} আপডেট`
      })
      const summary =
        `🔍 ${note} — ${items.length}টি product\n` +
        `${lines.join('\n')}\n\n⚠️ ISR/cache — live page আপডেট দেখতে কিছুক্ষণ লাগতে পারে।\n` +
        `একবার approve করলেই সব product-এর SEO কপি আপডেট হবে।`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId,
          type: 'seo_fix_batch',
          payload: { items, note, count: items.length, conversationId },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id,
          count: items.length,
          products: items.map((it) => it.slug),
          message: `${items.length}টি product-এর SEO ফিক্স একটাই approval card-এ — approve করলে সব লাইভ হবে।`,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const track_keyword: AgentTool = {
  name: 'track_keyword',
  description:
    'Add a keyword to weekly Google-rank tracking for almatraders.com. Adding costs nothing; the weekly ' +
    'rank-tracker cron then pulls the SERP for every tracked keyword (Oxylabs, ~1 credit each) — but only ' +
    'while the owner has rank-tracking turned ON. Use for terms the business wants to rank for, e.g. ' +
    '"premium panjabi Dhaka". Optionally tie it to the product slug it should rank for.',
  input_schema: {
    type: 'object' as const,
    properties: {
      keyword: { type: 'string', description: 'Search term, e.g. "family matching panjabi set"' },
      productSlug: { type: 'string', description: 'Optional product slug this keyword should rank for.' },
    },
    required: ['keyword'],
  },
  handler: async (input) => {
    const keyword = String(input.keyword ?? '').trim()
    if (!keyword) return { success: false, error: 'keyword দরকার।' }
    const productSlug = input.productSlug ? String(input.productSlug).trim() : null
    try {
      const count = await db.agentTrackedKeyword.count({ where: { active: true } })
      const existing = await db.agentTrackedKeyword.findFirst({ where: { keyword } })
      if (!existing && count >= RANK_TRACKING_MAX_KEYWORDS) {
        return { success: false, error: `সর্বোচ্চ ${RANK_TRACKING_MAX_KEYWORDS}টি keyword track করা যায় (খরচ নিয়ন্ত্রণে)। আগে একটা untrack করুন।` }
      }
      const row = await db.agentTrackedKeyword.upsert({
        where: { businessId_keyword: { businessId: 'ALMA_LIFESTYLE', keyword } },
        update: { active: true, productSlug },
        create: { keyword, productSlug, active: true },
      })
      return {
        success: true,
        data: { id: row.id, keyword, productSlug, message: `"${keyword}" এখন সাপ্তাহিক rank tracking-এ। (rank tracking ON থাকলে প্রতি সপ্তাহে SERP টানা হবে।)` },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const list_tracked_keywords: AgentTool = {
  name: 'list_tracked_keywords',
  description:
    'List the keywords under weekly rank tracking, each with its latest known Google rank (from the last ' +
    'SERP pull). Cost-free — reads stored history only.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const rows = await db.agentTrackedKeyword.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } })
      const out: Array<{ keyword: string; productSlug: string | null; latestRank: number | null; checkedAt: string | null }> = []
      for (const r of rows) {
        const last = await db.agentKeywordRank.findFirst({ where: { keyword: r.keyword }, orderBy: { checkedAt: 'desc' } })
        out.push({
          keyword: r.keyword,
          productSlug: r.productSlug ?? null,
          latestRank: last?.rank ?? null,
          checkedAt: last?.checkedAt ? new Date(last.checkedAt).toISOString() : null,
        })
      }
      return { success: true, data: { count: out.length, keywords: out } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const untrack_keyword: AgentTool = {
  name: 'untrack_keyword',
  description: 'Stop weekly rank tracking for a keyword (deactivates it — history is kept). Cost-free.',
  input_schema: {
    type: 'object' as const,
    properties: { keyword: { type: 'string' } },
    required: ['keyword'],
  },
  handler: async (input) => {
    const keyword = String(input.keyword ?? '').trim()
    if (!keyword) return { success: false, error: 'keyword দরকার।' }
    try {
      const upd = await db.agentTrackedKeyword.updateMany({ where: { keyword, active: true }, data: { active: false } })
      if (upd.count === 0) return { success: false, error: `"${keyword}" tracking-এ ছিল না।` }
      return { success: true, data: { keyword, message: `"${keyword}" tracking বন্ধ করা হয়েছে।` } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const get_search_console_performance: AgentTool = {
  name: 'get_search_console_performance',
  description:
    'REAL Google Search Console data for almatraders.com — actual clicks, impressions, CTR and average ' +
    'Google position, plus the top search queries and top landing pages over a date range. This is ground ' +
    'truth from Google (not an Oxylabs guess) and is completely FREE — prefer it over research_seo_keywords ' +
    'for how the site actually performs in search. Defaults to the last 28 days (GSC data lags ~3 days). ' +
    'Requires the owner to have connected Search Console once (Growth page).',
  input_schema: {
    type: 'object' as const,
    properties: {
      startDate: { type: 'string', description: 'YYYY-MM-DD. Default: 31 days ago.' },
      endDate: { type: 'string', description: 'YYYY-MM-DD. Default: 3 days ago (GSC data lag).' },
      rowLimit: { type: 'number', description: 'Max rows for top queries/pages (default 15, max 50).' },
      siteUrl: { type: 'string', description: 'Optional GSC property override, e.g. "sc-domain:almatraders.com". Auto-detected if omitted.' },
    },
  },
  handler: async (input) => {
    if (!(await isGscConnected())) return GSC_NOT_CONNECTED
    try {
      const startDate = input.startDate ? String(input.startDate) : ymd(31)
      const endDate = input.endDate ? String(input.endDate) : ymd(3)
      const rowLimit = Math.min(Math.max(Number(input.rowLimit ?? 15), 1), 50)
      const siteUrl = await resolveSiteUrl(input.siteUrl ? String(input.siteUrl) : undefined)

      const [totals, byQuery, byPage] = await Promise.all([
        searchAnalyticsQuery({ siteUrl, startDate, endDate, dimensions: [], rowLimit: 1 }),
        searchAnalyticsQuery({ siteUrl, startDate, endDate, dimensions: ['query'], rowLimit }),
        searchAnalyticsQuery({ siteUrl, startDate, endDate, dimensions: ['page'], rowLimit }),
      ])

      const t = totals.rows[0]
      const summary = t
        ? {
            clicks: t.clicks,
            impressions: t.impressions,
            ctr: Math.round(t.ctr * 1000) / 10, // percent, 1 decimal
            avgPosition: Math.round(t.position * 10) / 10,
          }
        : { clicks: 0, impressions: 0, ctr: 0, avgPosition: null }

      return {
        success: true,
        data: {
          siteUrl,
          dateRange: { startDate, endDate },
          totals: summary,
          topQueries: byQuery.rows.map((r) => ({
            query: r.keys[0],
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: Math.round(r.ctr * 1000) / 10,
            position: Math.round(r.position * 10) / 10,
          })),
          topPages: byPage.rows.map((r) => ({
            page: r.keys[0],
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: Math.round(r.ctr * 1000) / 10,
            position: Math.round(r.position * 10) / 10,
          })),
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not_connected')) return GSC_NOT_CONNECTED
      return { success: false, error: `Search Console query failed: ${msg}` }
    }
  },
}

const get_indexing_status: AgentTool = {
  name: 'get_indexing_status',
  description:
    'Google indexing / coverage status for almatraders.com from Search Console (FREE). With no argument it ' +
    'summarises the submitted sitemaps (submitted vs indexed URL counts, warnings, errors). Pass a full page ' +
    'URL to inspect that single page — whether Google has indexed it, its coverage state and last crawl time. ' +
    'Requires the owner to have connected Search Console once (Growth page).',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Optional full page URL to inspect (e.g. https://almatraders.com/products/xyz).' },
      siteUrl: { type: 'string', description: 'Optional GSC property override. Auto-detected if omitted.' },
    },
  },
  handler: async (input) => {
    if (!(await isGscConnected())) return GSC_NOT_CONNECTED
    try {
      const siteUrl = await resolveSiteUrl(input.siteUrl ? String(input.siteUrl) : undefined)

      if (input.url) {
        const url = String(input.url).trim()
        const r = await inspectUrl(siteUrl, url)
        return {
          success: true,
          data: {
            siteUrl,
            url,
            verdict: r.verdict ?? null,
            coverageState: r.coverageState ?? null,
            indexingState: r.indexingState ?? null,
            robotsTxtState: r.robotsTxtState ?? null,
            lastCrawlTime: r.lastCrawlTime ?? null,
            googleCanonical: r.googleCanonical ?? null,
          },
        }
      }

      const sitemaps = await listSitemaps(siteUrl)
      const out = sitemaps.map((s) => {
        const submitted = (s.contents ?? []).reduce((n, c) => n + Number(c.submitted ?? 0), 0)
        const indexed = (s.contents ?? []).reduce((n, c) => n + Number(c.indexed ?? 0), 0)
        return {
          path: s.path ?? null,
          lastSubmitted: s.lastSubmitted ?? null,
          lastDownloaded: s.lastDownloaded ?? null,
          isPending: Boolean(s.isPending),
          submitted,
          indexed,
          warnings: Number(s.warnings ?? 0),
          errors: Number(s.errors ?? 0),
        }
      })
      return {
        success: true,
        data: {
          siteUrl,
          sitemapCount: out.length,
          sitemaps: out,
          message: out.length === 0 ? 'কোনো sitemap submit করা নেই — Feature 4 (sitemap/IndexNow)-এ এটা ঠিক হবে।' : undefined,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not_connected')) return GSC_NOT_CONNECTED
      return { success: false, error: `Indexing status failed: ${msg}` }
    }
  },
}

export const SEO_TOOLS: AgentTool[] = [
  audit_product_seo,
  research_seo_keywords,
  draft_seo_fixes,
  track_keyword,
  list_tracked_keywords,
  untrack_keyword,
  get_search_console_performance,
  get_indexing_status,
]

export const SEO_ROLE_PROMPT = `
## SEO
audit_product_seo দিয়ে on-page SEO check করুন (cost-free) — title/meta description/description/alt-text/slug। scope="all_published" দিলে পুরো সাইট scan হয়।
**আসল Google ডেটা (ফ্রি):** সাইট search-এ কেমন করছে জানতে **get_search_console_performance** ব্যবহার করুন — Google Search Console থেকে সত্যিকারের clicks/impressions/CTR/গড় position + top query ও top page (ডিফল্ট শেষ ২৮ দিন)। ইনডেক্সিং/কভারেজ দেখতে **get_indexing_status** (আর্গুমেন্ট ছাড়া sitemap সারাংশ, বা নির্দিষ্ট page URL দিলে সেটা ইনডেক্স হয়েছে কিনা)। এগুলো ফ্রি ও নির্ভরযোগ্য — Oxylabs-এর আগে এগুলোই দেখুন। (owner একবার Growth পেজ থেকে Search Console connect করলে চালু হবে।)
research_seo_keywords দিয়ে keyword ranking দেখুন — **আগে confirm_oxylabs_spend** (≈১ ক্রেডিট), owner Approve ছাড়া চালাবেন না। GSC-তে যা পাওয়া যায় তার জন্য Oxylabs খরচ করবেন না।
**একসাথে অনেক product ঠিক করতে:** আগে audit চালান → যেসব product-এর meta/description দুর্বল, তাদের জন্য নিজে উন্নত বাংলা কপি লিখুন (meta 50-160 chars, description 100+ chars, keyword-rich, on-brand, হালাল) → তারপর **draft_seo_fixes**-এ সব একসাথে দিন। এতে owner **একটাই approval card**-এ পুরো ব্যাচ অনুমোদন করেন, approve করলেই সব লাইভ আপডেট হয়।
একটা মাত্র product-এর জন্য update_product_web-ও ব্যবহার করা যায় (price সহ)।
**র‍্যাঙ্ক ট্র্যাকিং:** যে keyword-এ business rank করতে চায় সেটা track_keyword দিয়ে যোগ করুন (যোগ করা ফ্রি) — rank tracking ON থাকলে প্রতি সপ্তাহে নিজে থেকে SERP টেনে owner-কে র‍্যাঙ্ক জানাবে। list_tracked_keywords-এ সর্বশেষ র‍্যাঙ্ক, untrack_keyword-এ বন্ধ। এককালীন check-এ research_seo_keywords (Approve লাগে)।
কখনোই নিজে থেকে content/meta change করবেন না — শুধু audit + draft + owner Approve।
`
