/**
 * Client-SEO audit engine — pure analysis + SSRF guard + scoring/report.
 * Run: node --test src/seo/__tests__/audit.test.mjs
 * (the live BFS crawl is verified against a real site in the e2e, since the
 * SSRF guard deliberately blocks localhost fixture servers.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeHtml,
  scoreAudit,
  buildReportMarkdown,
  unsafeAuditUrlReason,
  extractSitemapLocs,
  buildCrawlFrontier,
} from '../audit.mjs'

const GOOD = `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Premium Panjabi Collection — ALMA Lifestyle Dhaka</title>
  <meta name="description" content="Shop premium cotton panjabi in Dhaka with fast COD delivery across Bangladesh. New Eid collection now live at ALMA.">
  <link rel="canonical" href="https://shop.example.com/panjabi">
  <meta property="og:title" content="Panjabi"><meta property="og:image" content="https://x/y.jpg">
  <script type="application/ld+json">{"@type":"Product","name":"Panjabi"}</script>
  </head><body><h1>Panjabi Collection</h1>
  <p>${'সুন্দর পাঞ্জাবি কালেকশন। '.repeat(40)}</p>
  <img src="/a.jpg" alt="panjabi"><a href="/about">About</a><a href="https://ext.com">Ext</a>
  </body></html>`

const BAD = `<html><head>
  <meta name="robots" content="noindex,follow">
  <title>Hi</title>
  </head><body>
  <img src="http://insecure.example/x.jpg">
  <a href="/next">n</a>
  </body></html>`

test('a well-optimized page has no high/critical issues', () => {
  const a = analyzeHtml(GOOD, 'https://shop.example.com/panjabi')
  const bad = a.issues.filter((i) => i.severity === 'critical' || i.severity === 'high')
  assert.deepEqual(bad, [], JSON.stringify(bad))
  assert.equal(a.h1Count, 1)
  assert.ok(a.jsonLdTypes.includes('Product'))
  assert.deepEqual(a.internalLinks, ['https://shop.example.com/about'])
  assert.equal(a.externalCount, 1)
})

test('a broken page surfaces the right issue codes', () => {
  const a = analyzeHtml(BAD, 'https://shop.example.com/bad')
  const codes = a.issues.map((i) => i.code)
  for (const c of ['noindex', 'short_title', 'missing_meta_description', 'missing_viewport', 'missing_canonical', 'missing_structured_data', 'thin_content', 'mixed_content']) {
    assert.ok(codes.includes(c), `expected ${c} in ${codes.join(',')}`)
  }
  assert.equal(a.noindex, true)
})

test('scoring penalizes by severity and never goes below 0', () => {
  const crawl = {
    siteChecks: { issues: [{ severity: 'critical', code: 'no_https', detail: 'x' }] },
    pages: [analyzeHtml(BAD, 'https://shop.example.com/bad')],
  }
  const scored = scoreAudit(crawl)
  assert.ok(scored.score >= 0 && scored.score < 100)
  assert.equal(scored.counts.critical >= 1, true)

  const wrecked = { siteChecks: { issues: Array.from({ length: 20 }, () => ({ severity: 'critical', code: 'x', detail: 'y' })) }, pages: [] }
  assert.equal(scoreAudit(wrecked).score, 0)
})

test('page-level scoring is a RATE, so a deep crawl is not punished for being deep', () => {
  const badPage = () => analyzeHtml(BAD, 'https://shop.example.com/bad')
  const site = { issues: [] }
  const small = scoreAudit({ siteChecks: site, pages: Array.from({ length: 5 }, badPage), pagesCrawled: 5 })
  const big = scoreAudit({ siteChecks: site, pages: Array.from({ length: 80 }, badPage), pagesCrawled: 80 })

  // Same problem on every page ⇒ same score, whether we saw 5 pages or 80.
  assert.equal(small.score, big.score)
  // …and the raw counts still grow, so nothing is hidden from the report.
  assert.ok(big.counts.medium > small.counts.medium)
  // The old unbounded sum floored an 80-page crawl at 0; a real site must stay
  // on a usable scale so before/after is meaningful.
  assert.ok(big.score > 0, `expected a usable score, got ${big.score}`)
})

test('a mostly-clean deep crawl scores well above a broken one', () => {
  const site = { issues: [] }
  const clean = scoreAudit({
    siteChecks: site,
    pages: Array.from({ length: 40 }, () => analyzeHtml(GOOD, 'https://shop.example.com/panjabi')),
    pagesCrawled: 40,
  })
  const broken = scoreAudit({
    siteChecks: site,
    pages: Array.from({ length: 40 }, () => analyzeHtml(BAD, 'https://shop.example.com/bad')),
    pagesCrawled: 40,
  })
  assert.ok(clean.score > broken.score + 20, `${clean.score} vs ${broken.score}`)
})

test('report markdown includes score, severities and a prioritized plan', () => {
  const crawl = {
    origin: 'https://shop.example.com', pagesCrawled: 2, avgTtfbMs: 420,
    sitemap: { ok: true, count: 12 },
    siteChecks: { issues: [{ severity: 'high', code: 'broken_pages', detail: '2টা ভাঙা পেজ' }] },
    pages: [analyzeHtml(GOOD, 'https://shop.example.com/a'), analyzeHtml(BAD, 'https://shop.example.com/b')],
  }
  const scored = scoreAudit(crawl)
  const md = buildReportMarkdown({ url: 'https://shop.example.com', crawl, scored })
  assert.match(md, /স্কোর: \d+\/100/)
  assert.match(md, /অগ্রাধিকার অনুযায়ী করণীয়/)
  assert.match(md, /Sitemap: ✅ 12 URL/)
})

test('SSRF guard blocks private/loopback/metadata and bad schemes', () => {
  for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'https://foo.internal/', 'ftp://x.com/', 'http://x.com:8080/']) {
    assert.ok(unsafeAuditUrlReason(u), `should block ${u}`)
  }
  for (const u of ['https://almatraders.com/', 'http://example.com/page', 'https://sub.shop.com:443/x']) {
    assert.equal(unsafeAuditUrlReason(u), null, `should allow ${u}`)
  }
})

// Owner incident 2026-07-25 — almatraders.com has an 86-URL sitemap but a
// link-poor homepage, so link-following alone crawled 12 pages while the job
// summary still advertised "40 pages". The sitemap the crawler already parsed
// is now the crawl frontier.
test('sitemap <loc> entries are parsed, index sitemaps are recognised', () => {
  const plain = `<?xml version="1.0"?><urlset>
    <url><loc>https://shop.example.com/</loc></url>
    <url><loc> https://shop.example.com/panjabi </loc></url>
  </urlset>`
  const parsed = extractSitemapLocs(plain)
  assert.equal(parsed.isIndex, false)
  assert.deepEqual(parsed.locs, ['https://shop.example.com/', 'https://shop.example.com/panjabi'])

  const index = `<sitemapindex><sitemap><loc>https://shop.example.com/sitemap_products_1.xml</loc></sitemap></sitemapindex>`
  assert.equal(extractSitemapLocs(index).isIndex, true)
})

test('crawl frontier seeds from the sitemap, same-origin only, homepage first', () => {
  const { queue } = buildCrawlFrontier(
    'https://shop.example.com/',
    [
      'https://shop.example.com/panjabi',
      'https://shop.example.com/',            // duplicate of the seed
      'https://other-site.com/spam',          // cross-origin
      'not a url',                            // malformed
      'https://shop.example.com/about',
    ],
    40,
  )
  assert.deepEqual(queue, [
    'https://shop.example.com/',
    'https://shop.example.com/panjabi',
    'https://shop.example.com/about',
  ])
})

test('crawl frontier stays bounded for a huge sitemap', () => {
  const locs = Array.from({ length: 500 }, (_, i) => `https://shop.example.com/p/${i}`)
  const { queue } = buildCrawlFrontier('https://shop.example.com/', locs, 40)
  assert.ok(queue.length <= 81, `frontier should stay bounded, got ${queue.length}`)
  assert.ok(queue.length > 40, 'frontier should still hold more than one page of work')
})
