import { listWebsiteProducts, getWebsiteProduct } from '@/lib/website/catalog.service'
import { websiteSupabaseConfigured } from '@/lib/website/supabase-client'
import { oxylabsSerpSearch, oxylabsConfigured, logOxylabsUsage } from '@/lib/oxylabs/client'
import type { WebsiteProductDetail, WebsiteProductSummary } from '@/lib/website/types'
import type { AgentTool } from './registry'

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
    'exact query was already researched in this conversation before calling again.',
  input_schema: {
    type: 'object' as const,
    properties: {
      keyword: { type: 'string', description: 'Search term to check rankings for, e.g. "premium panjabi Dhaka"' },
      productSlug: { type: 'string', description: 'Optional — check if almatraders.com/products/{slug} appears in results for this keyword' },
    },
    required: ['keyword'],
  },
  handler: async (input) => {
    if (!oxylabsConfigured()) {
      return { success: false, error: 'Oxylabs not configured (OXYLABS_API_KEY missing).' }
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

export const SEO_TOOLS: AgentTool[] = [audit_product_seo, research_seo_keywords]

export const SEO_ROLE_PROMPT = `
## SEO
audit_product_seo দিয়ে on-page SEO check করুন (cost-free) — title/meta description/description/alt-text/slug।
research_seo_keywords দিয়ে keyword ranking দেখুন (Oxylabs credit খরচ হয় — শুধু genuine SEO সিদ্ধান্তের জন্য)।
SEO fix proposal করলে update_product_web ব্যবহার করুন (description/shortDescription) — owner Approve প্রয়োজন।
কখনোই নিজে থেকে content/meta change করবেন না — শুধু audit + proposal।
`
