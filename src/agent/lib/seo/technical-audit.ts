/**
 * Phase 47 — senior technical-SEO layer.
 *
 * The worker crawler (worker/src/seo/audit.mjs) produces per-page snapshots;
 * this module turns snapshots into DECISION-GRADE findings: every finding
 * carries evidence, affected URLs, expected impact, confidence, effort/risk,
 * a validation method, and a rollback — the roadmap exit gate. No ranking
 * guarantees, ever.
 *
 * `analyzePageLite` lets server code snapshot a page without the worker
 * (regex-based, no HTML-parser dependency — good enough for the checks below,
 * NOT a rendering engine; JavaScript-rendered content needs the browser path).
 */

export interface PageSnapshot {
  url: string
  statusCode?: number
  title: string
  titleLength: number
  metaDesc: string
  metaDescLength: number
  h1Count: number
  canonical: string | null
  noindex: boolean
  jsonLdTypes: string[]
  imgCount: number
  missingAlt: number
  wordCount: number
  internalLinks: string[]
  externalCount: number
  hreflangCount?: number
  hasViewport?: boolean
}

/** Regex-based snapshot for server-side one-off checks. Honest about its limits. */
export function analyzePageLite(html: string, url: string, statusCode?: number): PageSnapshot {
  const pick = (re: RegExp) => html.match(re)?.[1]?.trim() ?? ''
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const metaDesc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)
  const canonical = pick(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || null
  const robots = (pick(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i) || '').toLowerCase()
  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length
  const imgs = html.match(/<img[\s>][^>]*>/gi) ?? []
  const missingAlt = imgs.filter((tag) => !/alt=["'][^"']+["']/i.test(tag)).length
  const jsonLdTypes: string[] = []
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1])
      for (const item of Array.isArray(data) ? data : [data]) {
        if (item && item['@type']) jsonLdTypes.push(String(item['@type']))
      }
    } catch {
      jsonLdTypes.push('INVALID')
    }
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  const wordCount = text.split(/\s+/).filter(Boolean).length

  const internalLinks: string[] = []
  let externalCount = 0
  try {
    const base = new URL(url)
    for (const m of html.matchAll(/<a[^>]+href=["']([^"'#][^"']*)["']/gi)) {
      const href = m[1]
      if (/^(mailto:|tel:|javascript:)/i.test(href)) continue
      try {
        const abs = new URL(href, url)
        abs.hash = ''
        if (abs.hostname === base.hostname) internalLinks.push(abs.toString())
        else externalCount++
      } catch {
        /* bad href */
      }
    }
  } catch {
    /* bad base url */
  }

  return {
    url,
    statusCode,
    title,
    titleLength: title.length,
    metaDesc,
    metaDescLength: metaDesc.length,
    h1Count,
    canonical,
    noindex: robots.includes('noindex'),
    jsonLdTypes: jsonLdTypes.filter((t) => t !== 'INVALID'),
    imgCount: imgs.length,
    missingAlt,
    wordCount,
    internalLinks: [...new Set(internalLinks)],
    externalCount,
    hreflangCount: (html.match(/hreflang=/gi) ?? []).length,
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(html),
  }
}

export interface IndexabilityVerdict {
  indexable: boolean
  reasons: string[]
}

/** Why a URL can(not) be indexed — status, robots meta, canonical target. */
export function assessIndexability(page: PageSnapshot): IndexabilityVerdict {
  const reasons: string[] = []
  if (page.statusCode !== undefined && page.statusCode !== 200) reasons.push(`HTTP ${page.statusCode}`)
  if (page.noindex) reasons.push('meta robots noindex')
  if (page.canonical) {
    try {
      const canon = new URL(page.canonical, page.url).toString().replace(/\/$/, '')
      const self = new URL(page.url).toString().replace(/\/$/, '')
      if (canon !== self) reasons.push(`canonical points elsewhere (${page.canonical})`)
    } catch {
      reasons.push('canonical URL unparseable')
    }
  }
  return { indexable: reasons.length === 0, reasons }
}

export interface TechnicalFinding {
  code: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  evidence: string
  affectedUrls: string[]
  expectedImpact: string
  confidence: 'high' | 'medium' | 'low'
  effort: 'low' | 'medium' | 'high'
  validation: string
  rollback: string
}

/**
 * Aggregate page snapshots into prioritized, decision-grade findings.
 * Pure — same input, same findings.
 */
export function buildFindings(pages: PageSnapshot[]): TechnicalFinding[] {
  const findings: TechnicalFinding[] = []
  const urlsWhere = (pred: (p: PageSnapshot) => boolean) => pages.filter(pred).map((p) => p.url)

  const noindexed = urlsWhere((p) => p.noindex)
  if (noindexed.length > 0) {
    findings.push({
      code: 'noindex_pages',
      severity: 'critical',
      evidence: `${noindexed.length}/${pages.length} pages carry meta robots noindex`,
      affectedUrls: noindexed,
      expectedImpact: 'these pages cannot rank at all while noindexed',
      confidence: 'high',
      effort: 'low',
      validation: 'URL inspection (GSC) shows "Indexing allowed" after the fix',
      rollback: 'restore the noindex meta tag',
    })
  }

  const canonicalAway = pages.filter((p) => !p.noindex && !assessIndexability(p).indexable && p.canonical)
  if (canonicalAway.length > 0) {
    findings.push({
      code: 'canonical_points_elsewhere',
      severity: 'high',
      evidence: `${canonicalAway.length} pages canonicalize away from themselves`,
      affectedUrls: canonicalAway.map((p) => p.url),
      expectedImpact: 'consolidation signals leave these URLs — intended only for true duplicates',
      confidence: 'medium',
      effort: 'low',
      validation: 'verify intended canonical target per URL, then GSC inspection',
      rollback: 'restore previous canonical href',
    })
  }

  const noTitle = urlsWhere((p) => p.titleLength === 0)
  const badTitle = urlsWhere((p) => p.titleLength > 0 && (p.titleLength < 10 || p.titleLength > 65))
  if (noTitle.length > 0) {
    findings.push({
      code: 'missing_title',
      severity: 'critical',
      evidence: `${noTitle.length} pages have no <title>`,
      affectedUrls: noTitle,
      expectedImpact: 'title is a primary relevance + CTR signal; missing = severe',
      confidence: 'high',
      effort: 'low',
      validation: 'crawl again; SERP snippet check after recrawl',
      rollback: 'n/a (adding a title has no downside)',
    })
  }
  if (badTitle.length > 0) {
    findings.push({
      code: 'title_length',
      severity: 'medium',
      evidence: `${badTitle.length} pages have too-short/too-long titles`,
      affectedUrls: badTitle,
      expectedImpact: 'truncated/weak titles depress CTR; expect single-digit % CTR change, not ranking jumps',
      confidence: 'medium',
      effort: 'low',
      validation: 'GSC CTR for affected pages over 4 weeks vs prior 4 weeks',
      rollback: 'restore previous titles',
    })
  }

  const noDesc = urlsWhere((p) => p.metaDescLength === 0)
  if (noDesc.length > 0) {
    findings.push({
      code: 'missing_meta_description',
      severity: 'medium',
      evidence: `${noDesc.length} pages have no meta description`,
      affectedUrls: noDesc,
      expectedImpact: 'Google writes its own snippet — CTR opportunity lost; no direct ranking effect',
      confidence: 'high',
      effort: 'low',
      validation: 'SERP snippet + GSC CTR trend',
      rollback: 'n/a',
    })
  }

  const noH1 = urlsWhere((p) => p.h1Count === 0)
  if (noH1.length > 0) {
    findings.push({
      code: 'missing_h1',
      severity: 'medium',
      evidence: `${noH1.length} pages have no H1`,
      affectedUrls: noH1,
      expectedImpact: 'weak topical signal + accessibility issue',
      confidence: 'medium',
      effort: 'low',
      validation: 'recrawl',
      rollback: 'n/a',
    })
  }

  const noSchema = urlsWhere((p) => p.jsonLdTypes.length === 0)
  if (noSchema.length > 0 && noSchema.length >= pages.length / 2) {
    findings.push({
      code: 'missing_structured_data',
      severity: 'medium',
      evidence: `${noSchema.length}/${pages.length} pages have no JSON-LD`,
      affectedUrls: noSchema.slice(0, 20),
      expectedImpact: 'no rich-result eligibility (product price/rating snippets) — CTR opportunity',
      confidence: 'medium',
      effort: 'medium',
      validation: 'Rich Results Test per template after adding Product/Organization schema',
      rollback: 'remove the JSON-LD block',
    })
  }

  const thin = urlsWhere((p) => p.wordCount < 150)
  if (thin.length > 0) {
    findings.push({
      code: 'thin_content',
      severity: 'medium',
      evidence: `${thin.length} pages under 150 words`,
      affectedUrls: thin,
      expectedImpact: 'thin pages rarely rank for anything competitive; consolidate or enrich',
      confidence: 'medium',
      effort: 'high',
      validation: 'GSC impressions/position for the enriched pages over 6–8 weeks',
      rollback: 'content revert via git/CMS history',
    })
  }

  const altGaps = pages.filter((p) => p.imgCount > 0 && p.missingAlt / p.imgCount > 0.5)
  if (altGaps.length > 0) {
    findings.push({
      code: 'image_alt_coverage',
      severity: 'low',
      evidence: `${altGaps.length} pages have >50% images without alt text`,
      affectedUrls: altGaps.map((p) => p.url),
      expectedImpact: 'image search visibility + accessibility',
      confidence: 'high',
      effort: 'medium',
      validation: 'recrawl alt coverage',
      rollback: 'n/a',
    })
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 }
  return findings.sort((a, b) => order[a.severity] - order[b.severity])
}

/** Recommendations must never promise rankings — hard textual guard. */
export function containsRankingGuarantee(text: string): boolean {
  return /guarante\w*\s+(#?1|first|top|rank)|rank\s*#?1\s*(guarantee|নিশ্চিত)|র‍্যাঙ্ক(িং)?\s*(গ্যারান্টি|নিশ্চিত)|নিশ্চিত\s*র‍্যাঙ্ক/i.test(text)
}
