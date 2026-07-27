/**
 * Client-SEO audit engine — crawl ANY public website end-to-end and audit it
 * like an SEO expert (owner request 2026-07-05, extends the P4 SEO pack from
 * own-site-only to customer sites).
 *
 * Read-only by construction: polite same-origin GET crawl (delay between
 * requests, page/size/time caps), never submits anything. Self-contained SSRF
 * guard (mirrors src/agent/lib/browser/actions.ts): public http(s) hosts only,
 * validated per-URL at crawl time INCLUDING redirect hops — a page can link or
 * redirect anywhere, so app-side pre-approval is not enough.
 *
 * Output: a deterministic issue list (severity-weighted score), site-level
 * technical checks, per-page findings, and a Bangla markdown report — the
 * artifact the client_seo skill pack ships as proof.
 */
import { parse } from 'node-html-parser'

const MAX_PAGES_HARD = 80
const MAX_PAGE_BYTES = 3 * 1024 * 1024
const FETCH_TIMEOUT_MS = 12_000
const CRAWL_DELAY_MS = 300
const TOTAL_TIME_CAP_MS = 5 * 60_000
const MAX_REDIRECTS = 5

// ---------------------------------------------------------------------------
// SSRF guard (worker-side, per-URL)
// ---------------------------------------------------------------------------

function privateHostReason(hostname) {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'loopback/internal hostname'
  }
  if (host === 'metadata.google.internal') return 'cloud metadata endpoint'
  // IPv4 literal
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10 || a === 0) return 'private/reserved IPv4'
    if (a === 172 && b >= 16 && b <= 31) return 'private IPv4'
    if (a === 192 && b === 168) return 'private IPv4'
    if (a === 169 && b === 254) return 'link-local/metadata IPv4'
  }
  // IPv6 literal
  if (host.includes(':')) {
    if (host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) {
      return 'private/reserved IPv6'
    }
  }
  return null
}

export function unsafeAuditUrlReason(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return 'not a valid URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http(s) allowed'
  const priv = privateHostReason(url.hostname)
  if (priv) return priv
  if (url.port && !['80', '443', ''].includes(url.port)) return 'non-standard port not allowed'
  return null
}

// ---------------------------------------------------------------------------
// Fetch with manual redirect following (each hop re-guarded)
// ---------------------------------------------------------------------------

async function guardedFetch(rawUrl, { method = 'GET' } = {}) {
  let current = rawUrl
  const chain = []
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const bad = unsafeAuditUrlReason(current)
    if (bad) return { ok: false, error: `blocked (${bad}): ${current}`, chain }
    const startedAt = Date.now()
    let res
    try {
      res = await fetch(current, {
        method,
        redirect: 'manual',
        headers: {
          'User-Agent': 'ALMA-SEO-Audit/1.0 (+https://almatraders.com; polite read-only crawler)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
          'Accept-Encoding': 'gzip, br',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      return { ok: false, error: `fetch failed: ${err.message}`, chain }
    }
    const ttfbMs = Date.now() - startedAt
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return { ok: false, error: `redirect ${res.status} without location`, chain }
      chain.push({ url: current, status: res.status })
      current = new URL(loc, current).toString()
      continue
    }
    let bodyText = ''
    const type = res.headers.get('content-type') ?? ''
    if (method === 'GET' && /text|xml|html|json/.test(type)) {
      const buf = Buffer.from(await res.arrayBuffer())
      bodyText = buf.subarray(0, MAX_PAGE_BYTES).toString('utf8')
      return {
        ok: true, status: res.status, url: current, chain, ttfbMs, bodyText,
        bytes: buf.length, contentType: type,
        contentEncoding: res.headers.get('content-encoding') ?? null,
      }
    }
    return {
      ok: true, status: res.status, url: current, chain, ttfbMs, bodyText: '',
      bytes: 0, contentType: type, contentEncoding: res.headers.get('content-encoding') ?? null,
    }
  }
  return { ok: false, error: `too many redirects (>${MAX_REDIRECTS})`, chain }
}

// ---------------------------------------------------------------------------
// Per-page analysis (pure — unit-tested against fixture HTML)
// ---------------------------------------------------------------------------

export function analyzeHtml(html, pageUrl) {
  const root = parse(html, { comment: false })
  const issues = []
  const add = (severity, code, detail) => issues.push({ severity, code, detail })

  const title = root.querySelector('title')?.text?.trim() ?? ''
  if (!title) add('critical', 'missing_title', 'কোনো <title> নেই')
  else if (title.length < 10) add('high', 'short_title', `টাইটেল খুব ছোট (${title.length})`)
  else if (title.length > 65) add('medium', 'long_title', `টাইটেল খুব লম্বা (${title.length})`)

  const metaDesc = root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? ''
  if (!metaDesc) add('high', 'missing_meta_description', 'meta description নেই')
  else if (metaDesc.length < 50) add('medium', 'short_meta_description', `meta description ছোট (${metaDesc.length})`)
  else if (metaDesc.length > 165) add('low', 'long_meta_description', `meta description লম্বা (${metaDesc.length})`)

  const h1s = root.querySelectorAll('h1')
  if (h1s.length === 0) add('high', 'missing_h1', 'কোনো H1 নেই')
  else if (h1s.length > 1) add('low', 'multiple_h1', `${h1s.length}টা H1`)

  const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null
  if (!canonical) add('medium', 'missing_canonical', 'canonical link নেই')

  const robotsMeta = root.querySelector('meta[name="robots"]')?.getAttribute('content')?.toLowerCase() ?? ''
  const noindex = robotsMeta.includes('noindex')
  if (noindex) add('critical', 'noindex', 'পেজটা noindex — Google-এ আসবে না')

  if (!root.querySelector('meta[name="viewport"]')) {
    add('high', 'missing_viewport', 'mobile viewport meta নেই')
  }
  const htmlEl = root.querySelector('html')
  if (!htmlEl?.getAttribute('lang')) add('low', 'missing_lang', '<html lang> নেই')

  const ogTitle = root.querySelector('meta[property="og:title"]')
  const ogImage = root.querySelector('meta[property="og:image"]')
  if (!ogTitle || !ogImage) add('low', 'incomplete_open_graph', 'og:title/og:image অসম্পূর্ণ (share preview দুর্বল)')

  // Phase 47: hreflang sanity — a self-reference without x-default (or a lone
  // hreflang) is usually a half-done setup; only flag when hreflang exists.
  const hreflangs = root.querySelectorAll('link[rel="alternate"][hreflang]')
  if (hreflangs.length > 0) {
    const hasXDefault = hreflangs.some((l) => (l.getAttribute('hreflang') ?? '').toLowerCase() === 'x-default')
    if (!hasXDefault) add('low', 'hreflang_no_xdefault', `${hreflangs.length}টা hreflang আছে কিন্তু x-default নেই`)
  }

  const jsonLdTypes = []
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.text)
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) if (item && item['@type']) jsonLdTypes.push(String(item['@type']))
    } catch { /* invalid JSON-LD */ jsonLdTypes.push('INVALID') }
  }
  if (jsonLdTypes.length === 0) add('medium', 'missing_structured_data', 'কোনো schema.org (JSON-LD) নেই')
  if (jsonLdTypes.includes('INVALID')) add('medium', 'invalid_structured_data', 'JSON-LD ভাঙা')

  // A decorative image is SUPPOSED to have alt="" — that is the accessibility
  // rule, not a defect. Counting them cost the owner real time on 2026-07-26:
  // the audit reported "52+ images without alt, hurting Google Images and
  // accessibility", he ordered the fix, and the images turned out to be a
  // <div class="foot-strip" aria-hidden="true"> decorative footer strip that was
  // already correct. Tracking pixels are the same story.
  const isDecorative = (node) => {
    if (typeof node?.getAttribute !== 'function') return false
    if ((node.getAttribute('role') ?? '') === 'presentation') return true
    if ((node.getAttribute('aria-hidden') ?? '') === 'true') return true
    return isDecorative(node.parentNode)
  }
  // An image inside a control that ALREADY carries the name is correctly alt=""
  // — almatraders.com's thumbnails are
  // <button aria-label="সি-গ্রীন কালার পাঞ্জাবী …"><img alt=""/></button>, and an
  // alt there makes a screen reader say it twice. Such images still COUNT (Google
  // Images cares about them); they are simply not missing anything.
  const hasNamedAncestor = (node) => {
    if (typeof node?.getAttribute !== 'function') return false
    if (node.tagName && node.tagName !== 'IMG' && (node.getAttribute('aria-label') ?? '').trim()) return true
    return hasNamedAncestor(node.parentNode)
  }
  const isTrackingPixel = (i) => {
    const src = i.getAttribute('src') ?? ''
    if (/facebook\.com\/tr|\/pixel|analytics|googletagmanager/i.test(src)) return true
    return (i.getAttribute('width') ?? '') === '1' && (i.getAttribute('height') ?? '') === '1'
  }
  const contentImgs = root.querySelectorAll('img').filter((i) => !isDecorative(i) && !isTrackingPixel(i))
  const missingAlt = contentImgs.filter(
    (i) => !(i.getAttribute('alt') ?? '').trim() && !hasNamedAncestor(i),
  ).length
  if (contentImgs.length > 0 && missingAlt > 0) {
    add(
      missingAlt > contentImgs.length / 2 ? 'medium' : 'low',
      'missing_img_alt',
      `${contentImgs.length}টা কনটেন্ট ছবির মধ্যে ${missingAlt}টায় alt নেই`,
    )
  }

  const text = root.querySelector('body')?.structuredText ?? ''
  const wordCount = text.split(/\s+/).filter(Boolean).length
  if (wordCount < 150) add('medium', 'thin_content', `কনটেন্ট পাতলা (${wordCount} শব্দ)`)

  // mixed content on https pages
  if (pageUrl.startsWith('https://')) {
    const mixed = html.match(/(src|href)=["']http:\/\//g)?.length ?? 0
    if (mixed > 0) add('high', 'mixed_content', `${mixed}টা http:// রিসোর্স https পেজে`)
  }

  // links
  const base = new URL(pageUrl)
  const internal = new Set()
  let externalCount = 0
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? ''
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue
    try {
      const abs = new URL(href, pageUrl)
      abs.hash = ''
      if (abs.hostname === base.hostname) internal.add(abs.toString())
      else externalCount++
    } catch { /* bad href */ }
  }

  return {
    url: pageUrl, title, titleLength: title.length, metaDesc, metaDescLength: metaDesc.length,
    h1Count: h1s.length, canonical, noindex, jsonLdTypes: jsonLdTypes.filter((t) => t !== 'INVALID'),
    // `contentImgs`, not `imgs` — the decorative-alt correction renamed the
    // variable and this one reference was left behind, so EVERY audited page
    // threw "imgs is not defined" and the whole audit failed. The owner watched
    // it fail all day on 2026-07-27 before the card finally said why.
    imgCount: contentImgs.length, missingAlt, wordCount, internalLinks: [...internal], externalCount, issues,
  }
}

// ---------------------------------------------------------------------------
// Site crawl + site-level checks
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Pull <loc> entries out of a sitemap (or sitemap index) body. These are the
 * site's OWN declaration of what it wants indexed, so they make the best crawl
 * frontier — link-following alone missed most of a JS-rendered shop.
 */
export function extractSitemapLocs(xml) {
  const body = String(xml ?? '')
  return {
    locs: [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]),
    isIndex: /<sitemapindex/i.test(body),
  }
}

/**
 * Build the crawl frontier: homepage first, then same-origin sitemap URLs
 * (deduped, capped). Exported so the seeding contract is unit-testable without
 * a live crawl (the SSRF guard blocks fixture servers by design).
 */
export function buildCrawlFrontier(seedUrl, sitemapLocs, maxPages) {
  const queue = [seedUrl]
  const seen = new Set([seedUrl])
  let originStr
  try { originStr = new URL(seedUrl).origin } catch { return { queue, seen } }
  for (const loc of sitemapLocs) {
    if (queue.length >= maxPages * 2) break
    let normalized
    try {
      const u = new URL(loc)
      if (u.origin !== originStr) continue
      normalized = u.toString()
    } catch { continue }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    queue.push(normalized)
  }
  return { queue, seen }
}

export async function crawlSite({ url, maxPages = 40 }) {
  const startedAt = Date.now()
  maxPages = Math.min(Math.max(Number(maxPages) || 40, 5), MAX_PAGES_HARD)
  const seedBad = unsafeAuditUrlReason(url)
  if (seedBad) return { ok: false, error: `seed URL blocked: ${seedBad}` }

  const seed = await guardedFetch(url)
  if (!seed.ok) return { ok: false, error: `seed fetch failed: ${seed.error}` }
  const origin = new URL(seed.url)

  // Site-level probes
  const siteChecks = { issues: [] }
  const addSite = (severity, code, detail) => siteChecks.issues.push({ severity, code, detail })

  // https + redirect hygiene
  if (origin.protocol !== 'https:') addSite('critical', 'no_https', 'সাইট https-এ নেই')
  else {
    const httpProbe = await guardedFetch(`http://${origin.hostname}/`)
    if (httpProbe.ok && httpProbe.chain.length === 0 && httpProbe.status === 200) {
      addSite('high', 'http_not_redirected', 'http:// ভার্সন https-এ redirect হয় না (duplicate site)')
    }
  }
  if (seed.chain.length > 2) addSite('medium', 'long_redirect_chain', `হোমপেজে ${seed.chain.length} ধাপের redirect chain`)

  // robots.txt
  const robots = await guardedFetch(`${origin.origin}/robots.txt`)
  let sitemapUrls = []
  if (!robots.ok || robots.status !== 200) {
    addSite('medium', 'missing_robots', 'robots.txt নেই/পড়া যায়নি')
  } else {
    if (/^\s*User-agent:\s*\*\s*[\r\n]+\s*Disallow:\s*\/\s*$/im.test(robots.bodyText)) {
      addSite('critical', 'robots_blocks_all', 'robots.txt পুরো সাইট block করছে!')
    }
    sitemapUrls = [...robots.bodyText.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1])
  }

  // sitemap — parsed for coverage AND used as crawl seeds. Index sitemaps
  // (<sitemapindex>) are followed one level so a shop whose products live in
  // sitemap_products_1.xml is actually audited.
  if (sitemapUrls.length === 0) sitemapUrls = [`${origin.origin}/sitemap.xml`]
  let sitemapCount = 0
  let sitemapOk = false
  const sitemapLocs = []
  const readSitemap = async (target, depth = 0) => {
    const res = await guardedFetch(target)
    if (!res.ok || res.status !== 200 || !res.bodyText.includes('<')) return false
    const { locs, isIndex } = extractSitemapLocs(res.bodyText)
    if (isIndex && depth === 0) {
      let any = false
      for (const child of locs.slice(0, 10)) {
        if (await readSitemap(child, depth + 1)) any = true
      }
      return any
    }
    sitemapCount += locs.length
    for (const loc of locs) {
      try {
        const u = new URL(loc)
        if (u.origin === origin.origin) sitemapLocs.push(u.toString())
      } catch { /* skip malformed <loc> */ }
    }
    return true
  }
  for (const candidate of sitemapUrls.slice(0, 3)) {
    if (await readSitemap(candidate)) sitemapOk = true
  }
  if (!sitemapOk) addSite('medium', 'missing_sitemap', 'sitemap.xml নেই/পড়া যায়নি')

  // BFS crawl (same-origin). The frontier is seeded with the homepage AND the
  // sitemap's own URLs: a JS-rendered menu or a link-poor homepage used to
  // collapse the whole "40-page audit" to a couple of pages while the summary
  // still advertised the cap (owner incident 2026-07-25 — 12 pages crawled
  // against an 86-URL sitemap, reported as 40).
  const { queue, seen } = buildCrawlFrontier(seed.url, sitemapLocs, maxPages)
  const pages = []
  const fetchErrors = []
  while (queue.length > 0 && pages.length < maxPages && Date.now() - startedAt < TOTAL_TIME_CAP_MS) {
    const pageUrl = queue.shift()
    const res = pageUrl === seed.url ? seed : await guardedFetch(pageUrl)
    if (!res.ok) {
      fetchErrors.push({ url: pageUrl, error: res.error })
      continue
    }
    if (res.status >= 400) {
      pages.push({ url: pageUrl, status: res.status, issues: [{ severity: 'high', code: `http_${res.status}`, detail: `HTTP ${res.status}` }], internalLinks: [] })
      continue
    }
    if (!/html/.test(res.contentType)) continue
    const analysis = analyzeHtml(res.bodyText, res.url)
    analysis.status = res.status
    analysis.ttfbMs = res.ttfbMs
    analysis.bytes = res.bytes
    analysis.compressed = Boolean(res.contentEncoding)
    pages.push(analysis)
    for (const link of analysis.internalLinks) {
      if (!seen.has(link) && seen.size < maxPages * 3) {
        seen.add(link)
        queue.push(link)
      }
    }
    if (queue.length > 0) await sleep(CRAWL_DELAY_MS)
  }

  // Cross-page checks
  const byTitle = new Map()
  const byDesc = new Map()
  for (const p of pages) {
    if (p.title) byTitle.set(p.title, (byTitle.get(p.title) ?? 0) + 1)
    if (p.metaDesc) byDesc.set(p.metaDesc, (byDesc.get(p.metaDesc) ?? 0) + 1)
  }
  const dupTitles = [...byTitle.entries()].filter(([, n]) => n > 1)
  const dupDescs = [...byDesc.entries()].filter(([, n]) => n > 1)
  if (dupTitles.length) addSite('medium', 'duplicate_titles', `${dupTitles.length}টা টাইটেল একাধিক পেজে হুবহু এক`)
  if (dupDescs.length) addSite('low', 'duplicate_descriptions', `${dupDescs.length}টা meta description ডুপ্লিকেট`)

  const broken = pages.filter((p) => p.status >= 400)
  if (broken.length) addSite('high', 'broken_pages', `${broken.length}টা ভাঙা পেজ (4xx/5xx) internal link থেকে`)

  const htmlPages = pages.filter((p) => p.ttfbMs != null)
  const avgTtfb = htmlPages.length ? Math.round(htmlPages.reduce((s, p) => s + p.ttfbMs, 0) / htmlPages.length) : 0
  if (avgTtfb > 1500) addSite('high', 'slow_ttfb', `গড় TTFB ${avgTtfb}ms (>1.5s — ধীর সার্ভার)`)
  else if (avgTtfb > 800) addSite('medium', 'moderate_ttfb', `গড় TTFB ${avgTtfb}ms`)
  const uncompressed = htmlPages.filter((p) => !p.compressed).length
  if (htmlPages.length > 0 && uncompressed > htmlPages.length / 2) {
    addSite('medium', 'no_compression', 'অধিকাংশ পেজ gzip/br compression ছাড়া যাচ্ছে')
  }

  return {
    ok: true, origin: origin.origin, pagesCrawled: pages.length, fetchErrors,
    sitemap: { ok: sitemapOk, count: sitemapCount }, siteChecks, pages,
    avgTtfbMs: avgTtfb, elapsedMs: Date.now() - startedAt,
  }
}

// ---------------------------------------------------------------------------
// Scoring + report
// ---------------------------------------------------------------------------

const WEIGHT = { critical: 15, high: 6, medium: 2, low: 0.5 }

/**
 * Page-level issues are scored by RATE, not by raw count (owner incident
 * 2026-07-25: an 80-page crawl of a 91-URL sitemap scored 0/100 because the old
 * penalty was an unbounded sum — every extra page crawled made the site look
 * worse, so a deep audit was punished for being deep and 0 told Boss nothing).
 *
 * The rule now:
 *   - a SITE-level issue (no https, sitemap missing, broken pages) keeps its flat
 *     weight — there is one site, so one penalty;
 *   - a PAGE-level issue costs `weight × (how many pages carry it / pages
 *     crawled)`, scaled by PAGE_RATE_MULT. "every page misses an H1" now costs the
 *     same whether we crawled 10 pages or 80, which is what makes a before/after
 *     comparison honest;
 *   - each severity's page contribution is capped so one noisy family can never
 *     floor the score on its own and hide everything else.
 *
 * Raw counts are unchanged and still reported next to the score.
 */
/**
 * Calibration (owner review 2026-07-26): the first version of this normalisation
 * over-corrected. A real audit — 10 medium and 79 low findings spread over 80
 * pages — scored 95/100, which flatters the site as badly as the old unbounded
 * sum floored it at 0. The cause: a `low` issue on EVERY page cost 1.5 points.
 *
 * A problem present on every page is systematic, not cosmetic, so the cost is now
 * expressed directly: FULL_RATE_COST is what a severity costs when it affects
 * every crawled page, scaled linearly by how much of the site it actually
 * touches. Rate still means the score is comparable across crawl sizes.
 */
const FULL_RATE_COST = { critical: 45, high: 30, medium: 18, low: 10 }

export function scoreAudit(crawl) {
  const siteIssues = crawl.siteChecks.issues.map((i) => ({ ...i, scope: 'site' }))
  const pageIssues = crawl.pages.flatMap((p) => p.issues.map((i) => ({ ...i, scope: p.url })))
  const all = [...siteIssues, ...pageIssues]

  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const i of all) counts[i.severity] = (counts[i.severity] ?? 0) + 1

  let penalty = 0
  for (const i of siteIssues) penalty += WEIGHT[i.severity] ?? 1

  const pagesCrawled = crawl.pagesCrawled ?? crawl.pages.length ?? 0
  if (pagesCrawled > 0) {
    const perSeverity = {}
    for (const i of pageIssues) perSeverity[i.severity] = (perSeverity[i.severity] ?? 0) + 1
    for (const [severity, n] of Object.entries(perSeverity)) {
      const rate = Math.min(n / pagesCrawled, 1)
      penalty += (FULL_RATE_COST[severity] ?? 10) * rate
    }
  } else {
    // No page was crawled — nothing to normalise against; fall back to flat sums.
    for (const i of pageIssues) penalty += WEIGHT[i.severity] ?? 1
  }

  const score = Math.max(0, Math.round(100 - penalty))
  return { score, counts, issues: all }
}

export function buildReportMarkdown({ url, crawl, scored, keywordsNote }) {
  const lines = [
    `# SEO অডিট রিপোর্ট — ${url}`,
    '',
    `**স্কোর: ${scored.score}/100** · পেজ দেখা হয়েছে: ${crawl.pagesCrawled}`
      + (crawl.sitemap.count ? ` / sitemap-এ ${crawl.sitemap.count}` : '')
      + ` · গড় TTFB: ${crawl.avgTtfbMs}ms · ক্রল সময়: ${Math.round((crawl.elapsedMs ?? 0) / 1000)}s`,
    `সমস্যা: 🔴 critical ${scored.counts.critical} · 🟠 high ${scored.counts.high} · 🟡 medium ${scored.counts.medium} · ⚪ low ${scored.counts.low}`,
    '',
    '## সাইট-লেভেল সমস্যা',
  ]
  if (crawl.siteChecks.issues.length === 0) lines.push('- ✅ কোনো সাইট-লেভেল সমস্যা পাওয়া যায়নি')
  for (const i of crawl.siteChecks.issues) lines.push(`- [${i.severity}] ${i.detail} \`${i.code}\``)
  lines.push('', `- Sitemap: ${crawl.sitemap.ok ? `✅ ${crawl.sitemap.count} URL` : '❌ নেই'}`)

  lines.push('', '## পেজ-ধরে সমস্যা (severity অনুযায়ী)')
  for (const sev of ['critical', 'high', 'medium', 'low']) {
    const items = []
    for (const p of crawl.pages) {
      for (const i of p.issues.filter((x) => x.severity === sev)) {
        items.push(`- ${i.detail} — ${p.url} \`${i.code}\``)
      }
    }
    if (items.length) {
      lines.push('', `### ${sev.toUpperCase()} (${items.length})`, ...items.slice(0, 40))
      if (items.length > 40) lines.push(`- … আরো ${items.length - 40}টা (audit.json-এ পুরো তালিকা)`)
    }
  }

  if (keywordsNote) lines.push('', '## কীওয়ার্ড প্রেক্ষাপট', keywordsNote)

  lines.push(
    '',
    '## অগ্রাধিকার অনুযায়ী করণীয়',
    '1. আগে 🔴 critical (noindex/robots/https) — এগুলো ঠিক না হলে বাকি সব বৃথা',
    '2. তারপর 🟠 high — ভাঙা পেজ, missing H1/meta, mixed content, স্পিড',
    '3. তারপর 🟡 medium — canonical, structured data, thin content, duplicate',
    '4. শেষে ⚪ low polish',
    '',
    `_ALMA agent SEO audit · ${new Date().toISOString()} · read-only crawl_`,
  )
  return lines.join('\n')
}

/**
 * Job entrypoint. @param {{url: string, maxPages?: number, keywordsNote?: string}} payload
 */
export async function runSeoAudit(payload) {
  const url = String(payload.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url must be http(s)' }
  const crawl = await crawlSite({ url, maxPages: payload.maxPages })
  if (!crawl.ok) return { ok: false, error: crawl.error }
  const scored = scoreAudit(crawl)
  const report = buildReportMarkdown({ url, crawl, scored, keywordsNote: payload.keywordsNote })
  return {
    ok: true,
    score: scored.score,
    counts: scored.counts,
    pagesCrawled: crawl.pagesCrawled,
    avgTtfbMs: crawl.avgTtfbMs,
    // Honesty of coverage: how long the crawl really took and how much of the
    // site it really saw. Both were dropped before, which is what made a
    // 1-page/5-second run indistinguishable from a 40-page audit.
    elapsedMs: crawl.elapsedMs,
    sitemapCount: crawl.sitemap.count,
    maxPages: Math.min(Math.max(Number(payload.maxPages) || 40, 5), MAX_PAGES_HARD),
    reportMarkdown: report,
    auditJson: {
      url,
      crawledAt: new Date().toISOString(),
      score: scored.score,
      counts: scored.counts,
      pagesCrawled: crawl.pagesCrawled,
      elapsedMs: crawl.elapsedMs,
      avgTtfbMs: crawl.avgTtfbMs,
      siteChecks: crawl.siteChecks,
      sitemap: crawl.sitemap,
      pages: crawl.pages.map(({ internalLinks, ...p }) => p),
    },
  }
}
