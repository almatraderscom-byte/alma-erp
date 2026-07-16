import { prisma } from '@/lib/prisma'
import { listWebsiteProducts, getWebsiteProduct } from '@/lib/website/catalog.service'
import { websiteSupabaseConfigured } from '@/lib/website/supabase-client'
import { oxylabsSerpSearch, oxylabsConfigured, logOxylabsUsage } from '@/lib/oxylabs/client'
import { verifyOxylabsSpendApproval, consumeOxylabsApproval } from '@/agent/lib/oxylabs-approval'
import { RANK_TRACKING_MAX_KEYWORDS } from '@/agent/lib/growth/settings'
import { submitToIndexNow } from '@/agent/lib/growth/indexnow'
import {
  isGscConnected,
  resolveSiteUrl,
  searchAnalyticsQuery,
  listSitemaps,
  inspectUrl,
} from '@/agent/lib/gsc'
import { analyzePageLite, buildFindings, assessIndexability, type PageSnapshot } from '@/agent/lib/seo/technical-audit'
import { buildTopicClusters, findContentGaps, type QueryRow } from '@/agent/lib/seo/content-strategy'
import { buildLinkGraph, suggestInternalLinks } from '@/agent/lib/seo/internal-links'
import { validateReleasePlan, applyTransition, type SeoReleasePlan, type ReleaseStatus } from '@/agent/lib/seo/release-graph'
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
            // Expose images so alt-text fixes can be drafted per image URL.
            images: (product.images ?? []).map((img) => ({
              url: img.url,
              alt: img.alt ?? null,
              hasAlt: Boolean(img.alt && img.alt.trim()),
            })),
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
      productSlug: { type: 'string', description: 'Optional — check if {siteDomain}/products/{slug} appears in results for this keyword' },
      siteDomain: {
        type: 'string',
        description:
          'Optional — the domain to check the ranking of (e.g. "customer-shop.com"). Omit for the ' +
          'own site (almatraders.com). Use this for a CLIENT SEO audit of another website.',
      },
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
    // Default target is the own site; a client SEO audit passes siteDomain.
    const targetDomain = String(input.siteDomain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase() || 'almatraders.com'
    let almaRank: number | null = null
    let almaUrl: string | null = null
    for (const r of results) {
      if (r.url.toLowerCase().includes(targetDomain)) {
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
        targetDomain,
        top10: results.map(r => ({ rank: r.pos, url: r.url, title: r.title })),
        siteRanking: almaRank !== null
          ? { rank: almaRank, url: almaUrl }
          : { rank: null, message: `Top 10-এ ${targetDomain} নেই` },
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
    'Workflow: first run audit_product_seo to find products with weak title/meta/description/alt-text, then YOU draft the improved ' +
    'Bangla copy for each (title 10-70 chars, meta description 50-160 chars, product description 100+ chars, image alt-text descriptive, ' +
    'keyword-rich, on-brand, halal-compliant), then call this with the drafts. The owner approves the whole batch at once; on approval each ' +
    'product\'s title/shortDescription/description and image alt-text are updated live. NEVER auto-apply — this only creates the pending card. ' +
    'Writable via SEO fixes: title (name), shortDescription (meta), description, and imageAlts (per-image alt-text). ' +
    'Slug changes are NOT supported here (they need a 301 redirect — coordinate with the owner separately).',
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
            title: { type: 'string', description: 'New SEO-friendly product title/name, 10-70 chars, Bangla, keyword-rich.' },
            shortDescription: { type: 'string', description: 'New meta description, 50-160 chars, Bangla, keyword-rich.' },
            description: { type: 'string', description: 'New/expanded product description, 100+ chars.' },
            imageAlts: {
              type: 'array',
              description: 'Per-image alt-text. Use the exact image url from audit_product_seo. Alt = short descriptive Bangla phrase for the image.',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'Exact image URL (from audit_product_seo images list).' },
                  alt: { type: 'string', description: 'Descriptive Bangla alt-text, 5-125 chars.' },
                },
                required: ['url', 'alt'],
              },
            },
          },
          required: ['slugOrId'],
        },
      },
      note: { type: 'string', description: 'Short label for this SEO batch (shown on the card).' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
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
        fields: { shortDescription?: string; description?: string; title?: string }
        imageAlts?: Array<{ url: string; alt: string }>
        changes: Record<string, { before: unknown; after: unknown }>
      }> = []

      for (let i = 0; i < rawFixes.length; i++) {
        const f = rawFixes[i] as Record<string, unknown>
        const slugOrId = String(f.slugOrId ?? '').trim()
        if (!slugOrId) return { success: false, error: `ফিক্স #${i + 1}: slugOrId খালি।` }
        const product = await getWebsiteProduct(slugOrId)
        if (!product) return { success: false, error: `ফিক্স #${i + 1}: product পাওয়া যায়নি (${slugOrId})।` }

        const fields: { shortDescription?: string; description?: string; title?: string } = {}
        const changes: Record<string, { before: unknown; after: unknown }> = {}

        if (f.title != null) {
          const title = String(f.title).trim()
          if (title.length < 10 || title.length > 70) {
            return { success: false, error: `ফিক্স #${i + 1} (${product.slug}): title ${title.length} chars — 10-70-এর মধ্যে দিন।` }
          }
          fields.title = title
          changes.title = { before: product.name?.slice(0, 80) ?? null, after: title.slice(0, 80) }
        }
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

        let imageAlts: Array<{ url: string; alt: string }> | undefined
        if (f.imageAlts != null) {
          const raw = Array.isArray(f.imageAlts) ? f.imageAlts : []
          const validUrls = new Set((product.images ?? []).map((img) => img.url))
          const parsed: Array<{ url: string; alt: string }> = []
          for (let j = 0; j < raw.length; j++) {
            const a = raw[j] as Record<string, unknown>
            const url = String(a.url ?? '').trim()
            const alt = String(a.alt ?? '').trim()
            if (!url || !alt) {
              return { success: false, error: `ফিক্স #${i + 1} (${product.slug}) alt #${j + 1}: url ও alt দুটোই দিন।` }
            }
            if (!validUrls.has(url)) {
              return { success: false, error: `ফিক্স #${i + 1} (${product.slug}) alt #${j + 1}: এই product-এ এই image url নেই (audit_product_seo থেকে সঠিক url নিন)।` }
            }
            if (alt.length < 5 || alt.length > 125) {
              return { success: false, error: `ফিক্স #${i + 1} (${product.slug}) alt #${j + 1}: alt ${alt.length} chars — 5-125-এর মধ্যে দিন।` }
            }
            parsed.push({ url, alt })
          }
          if (parsed.length > 0) {
            imageAlts = parsed
            changes.imageAlts = { before: `${(product.images ?? []).filter((im) => !im.alt || !im.alt.trim()).length}টি ছবিতে alt নেই`, after: `${parsed.length}টি ছবিতে alt যোগ` }
          }
        }

        if (Object.keys(fields).length === 0 && !imageAlts) {
          return { success: false, error: `ফিক্স #${i + 1} (${product.slug}): title / shortDescription / description / imageAlts অন্তত একটা দিন।` }
        }
        items.push({ productId: product.id, slug: product.slug, name: product.name, fields, imageAlts, changes })
      }

      const lines = items.map((it) => {
        const parts = Object.keys(it.changes).map((k) =>
          k === 'shortDescription' ? 'meta' : k === 'imageAlts' ? 'alt-text' : k,
        )
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
    properties: { keyword: { type: 'string', description: 'The tracked keyword to deactivate' } },
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
          message:
            out.length === 0
              ? 'GSC-তে কোনো sitemap submit দেখা যাচ্ছে না। storefront live sitemap.xml দেয় (' +
                'https://www.almatraders.com/sitemap.xml — product page সহ); owner চাইলে Search Console-এ একবার ' +
                'sitemap URL টা submit করলেই coverage ট্র্যাক হবে। পেজ বদলালে দ্রুত re-crawl-এর জন্য submit_to_indexnow।'
              : undefined,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not_connected')) return GSC_NOT_CONNECTED
      return { success: false, error: `Indexing status failed: ${msg}` }
    }
  },
}

const submit_to_indexnow: AgentTool = {
  name: 'submit_to_indexnow',
  description:
    'Ping IndexNow to tell search engines a storefront page just changed, so they re-crawl it fast (FREE, ' +
    'no OAuth). IndexNow broadcasts to Bing, Yandex, Naver, Seznam etc. — NOT Google (Google indexing still ' +
    'relies on the live sitemap + Search Console). Call this right AFTER an SEO fix is applied (e.g. after the ' +
    'owner approves draft_seo_fixes), passing the changed product(s). Accepts full almatraders.com URLs, ' +
    '"/products/slug" paths, or bare product slugs. Off-host URLs are ignored. Requires INDEXNOW_KEY in env ' +
    'and the matching <key>.txt file hosted on the storefront root — without the key file the ping is accepted ' +
    '(HTTP 202) but engines will not crawl until the file is live.',
  input_schema: {
    type: 'object' as const,
    properties: {
      urls: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Changed page targets — full almatraders.com URLs, "/products/slug" paths, or bare product slugs. Max 100.',
      },
    },
    required: ['urls'],
  },
  handler: async (input) => {
    const raw = Array.isArray(input.urls) ? input.urls.map((u) => String(u)) : []
    if (raw.length === 0) {
      return { success: false, error: 'কোন URL/slug সাবমিট করতে হবে সেটা urls-এ দিন।' }
    }
    const result = await submitToIndexNow(raw)
    if (!result.ok) return { success: false, error: result.error }
    return {
      success: true,
      data: {
        status: result.status,
        submittedCount: result.submitted.length,
        submitted: result.submitted,
        keyLocation: result.keyLocation,
        keyValidationPending: result.keyValidationPending,
        message: result.message,
      },
    }
  },
}

const seo_technical_audit: AgentTool = {
  name: 'seo_technical_audit',
  description:
    'Phase 47 technical SEO audit over up to 5 live URLs: fetch each page, snapshot title/meta/canonical/robots/H1/' +
    'JSON-LD/alt/word-count/links, assess indexability, then return prioritized findings — each with evidence, ' +
    'affected URLs, expected impact, confidence, effort, validation method and rollback — plus an internal-link graph ' +
    '(orphans/dead-ends/depth) with ranked link suggestions. Read-only; regex snapshot (JS-rendered content needs the browser path).',
  input_schema: {
    type: 'object' as const,
    properties: {
      urls: { type: 'array', items: { type: 'string' }, description: 'Up to 5 absolute URLs (first one is treated as home for depth)' },
    },
    required: ['urls'],
  },
  handler: async (input) => {
    try {
      const urls = (input.urls as string[]).slice(0, 5)
      if (!urls.length) return { success: false, error: 'at least one URL required' }
      const snapshots: PageSnapshot[] = []
      for (const url of urls) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' })
          const html = await res.text()
          snapshots.push(analyzePageLite(html, url, res.status))
        } catch (err) {
          snapshots.push({
            url, statusCode: 0, title: '', titleLength: 0, metaDesc: '', metaDescLength: 0, h1Count: 0,
            canonical: null, noindex: false, jsonLdTypes: [], imgCount: 0, missingAlt: 0, wordCount: 0,
            internalLinks: [], externalCount: 0,
          })
          void err
        }
      }
      const graph = buildLinkGraph(snapshots, urls[0])
      return {
        success: true,
        data: {
          findings: buildFindings(snapshots),
          indexability: snapshots.map((s) => ({ url: s.url, ...assessIndexability(s) })),
          linkGraph: { orphans: graph.orphans, deadEnds: graph.deadEnds, unreachable: graph.unreachable },
          linkSuggestions: suggestInternalLinks(graph),
          note: 'কোনো ranking guarantee নেই — প্রতিটা finding-এর validation method + realistic window ধরে মাপতে হবে।',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const seo_content_clusters: AgentTool = {
  name: 'seo_content_clusters',
  description:
    'Topic clusters + content gaps from REAL Search Console queries: intent classification (transactional/commercial/' +
    'navigational/informational, Bangla-aware), clusters ranked by opportunity (position 5–20 with impressions), and ' +
    'gaps where demand exists but no dedicated page does. Needs GSC connected. Read-only; data freshness/row limits labelled.',
  input_schema: {
    type: 'object' as const,
    properties: {
      days: { type: 'number', description: 'Lookback window (default 28)' },
      existingSlugs: { type: 'array', items: { type: 'string' }, description: 'Known page slugs to check gap coverage against' },
    },
  },
  handler: async (input) => {
    try {
      if (!(await isGscConnected())) return GSC_NOT_CONNECTED
      const siteUrl = await resolveSiteUrl()
      const days = Math.min(Math.max(Number(input.days ?? 28), 7), 90)
      const { rows, rowLimitHit } = await searchAnalyticsQuery({
        siteUrl,
        startDate: ymd(days),
        endDate: ymd(0),
        dimensions: ['query'],
        rowLimit: 250,
      })
      const queryRows: QueryRow[] = rows.map((r) => ({
        query: r.keys[0] ?? '',
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }))
      const clusters = buildTopicClusters(queryRows)
      const gaps = findContentGaps(clusters, (input.existingSlugs as string[]) ?? [])
      return {
        success: true,
        data: {
          clusters: clusters.slice(0, 15).map((c) => ({ ...c, members: c.members.slice(0, 5) })),
          gaps,
          honesty: `GSC final data lags ~2–3 days; ${rowLimitHit ? 'row limit HIT — এটা partial view' : 'full window read'}.`,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const seo_release_plan: AgentTool = {
  name: 'seo_release_plan',
  description:
    'Validate/advance an SEO/CRO release plan through the loop draft→approved→preview_verified→released→rolled_back. ' +
    'Every change needs description+affectedUrls+evidence+validation+rollback; ranking guarantees are rejected; ' +
    '"released" only ever by the OWNER (agent never deploys production). action=validate|transition.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', description: 'validate | transition' },
      plan: { type: 'object', description: 'SeoReleasePlan {id,title,changes[],status}' },
      to: { type: 'string', description: 'transition: target status' },
      actor: { type: 'string', description: 'transition: "agent" or "owner" (released requires owner)' },
    },
    required: ['action', 'plan'],
  },
  handler: async (input) => {
    try {
      const plan = input.plan as unknown as SeoReleasePlan
      if (input.action === 'validate') {
        return { success: true, data: validateReleasePlan(plan) }
      }
      if (input.action === 'transition') {
        const result = applyTransition(plan, String(input.to) as ReleaseStatus, input.actor === 'owner' ? 'owner' : 'agent')
        return result.ok ? { success: true, data: result } : { success: false, error: result.error }
      }
      return { success: false, error: `unknown action "${input.action}"` }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
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
  submit_to_indexnow,
  seo_technical_audit,
  seo_content_clusters,
  seo_release_plan,
]

export const SEO_ROLE_PROMPT = `
## SEO
audit_product_seo দিয়ে on-page SEO check করুন (cost-free) — title/meta description/description/alt-text/slug। scope="all_published" দিলে পুরো সাইট scan হয়।
**আসল Google ডেটা (ফ্রি):** সাইট search-এ কেমন করছে জানতে **get_search_console_performance** ব্যবহার করুন — Google Search Console থেকে সত্যিকারের clicks/impressions/CTR/গড় position + top query ও top page (ডিফল্ট শেষ ২৮ দিন)। ইনডেক্সিং/কভারেজ দেখতে **get_indexing_status** (আর্গুমেন্ট ছাড়া sitemap সারাংশ, বা নির্দিষ্ট page URL দিলে সেটা ইনডেক্স হয়েছে কিনা)। এগুলো ফ্রি ও নির্ভরযোগ্য — Oxylabs-এর আগে এগুলোই দেখুন। (owner একবার Growth পেজ থেকে Search Console connect করলে চালু হবে।)
research_seo_keywords দিয়ে keyword ranking দেখুন — **আগে confirm_oxylabs_spend** (≈১ ক্রেডিট), owner Approve ছাড়া চালাবেন না। GSC-তে যা পাওয়া যায় তার জন্য Oxylabs খরচ করবেন না।
**একসাথে অনেক product ঠিক করতে:** আগে audit চালান → যেসব product-এর title/meta/description/alt-text দুর্বল, তাদের জন্য নিজে উন্নত বাংলা কপি লিখুন (title 10-70 chars, meta 50-160 chars, description 100+ chars, image alt-text সংক্ষিপ্ত বর্ণনামূলক, keyword-rich, on-brand, হালাল) → তারপর **draft_seo_fixes**-এ সব একসাথে দিন। title, shortDescription (meta), description, ও imageAlts (per-image alt-text, single-product audit-এ image url পাবেন) — এই ফিল্ডগুলো লেখা যায়। slug পরিবর্তন এখান থেকে হয় না (301 redirect লাগে — owner-এর সাথে আলাদা করে করবেন)। owner **একটাই approval card**-এ পুরো ব্যাচ অনুমোদন করেন, approve করলেই সব লাইভ আপডেট হয়।
একটা মাত্র product-এর জন্য update_product_web-ও ব্যবহার করা যায় (price সহ)।
**র‍্যাঙ্ক ট্র্যাকিং:** যে keyword-এ business rank করতে চায় সেটা track_keyword দিয়ে যোগ করুন (যোগ করা ফ্রি) — rank tracking ON থাকলে প্রতি সপ্তাহে নিজে থেকে SERP টেনে owner-কে র‍্যাঙ্ক জানাবে। list_tracked_keywords-এ সর্বশেষ র‍্যাঙ্ক, untrack_keyword-এ বন্ধ। এককালীন check-এ research_seo_keywords (Approve লাগে)।
কখনোই নিজে থেকে content/meta change করবেন না — শুধু audit + draft + owner Approve।
**Phase 47 senior SEO:** সাইট-লেভেল টেকনিক্যাল সমস্যা (noindex/canonical/schema/thin content/orphan pages) দেখতে **seo_technical_audit** (৫টা পর্যন্ত URL) — প্রতিটা finding-এ evidence+impact+confidence+validation+rollback থাকে। GSC query থেকে topic cluster + content gap পেতে **seo_content_clusters**। কোনো SEO/CRO পরিবর্তনের প্ল্যান **seo_release_plan** দিয়ে validate/track করুন — released শুধু owner-ই করে (এজেন্ট কখনো production deploy করে না), আর ranking guarantee নিষিদ্ধ।
**দ্রুত re-crawl (IndexNow):** কোনো product-এর SEO ঠিক হওয়ার পর (owner draft_seo_fixes approve করলে) **submit_to_indexnow**-এ ওই product-এর slug/URL দিন — Bing/Yandex ইত্যাদি সাথে সাথে re-crawl করবে (ফ্রি, Google এতে নেই — Google-এর জন্য sitemap + Search Console)। INDEXNOW_KEY env + storefront root-এ <key>.txt ফাইল লাগে; ফাইল না থাকলে ping গৃহীত হয় (202) কিন্তু crawl হয় না — সেটা owner-কে জানাবেন।
`
