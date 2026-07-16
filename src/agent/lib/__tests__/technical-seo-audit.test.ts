import { describe, it, expect } from 'vitest'
import {
  analyzePageLite,
  assessIndexability,
  buildFindings,
  containsRankingGuarantee,
  type PageSnapshot,
} from '@/agent/lib/seo/technical-audit'
import { classifyIntent, buildTopicClusters, findContentGaps, type QueryRow } from '@/agent/lib/seo/content-strategy'
import { buildLinkGraph, suggestInternalLinks } from '@/agent/lib/seo/internal-links'

const GOOD_HTML = `<!doctype html><html lang="bn"><head>
<title>বাবা-ছেলের ম্যাচিং পাঞ্জাবি সেট — ALMA Lifestyle</title>
<meta name="description" content="প্রিমিয়াম কটন পাঞ্জাবি সেট, ঢাকায় ক্যাশ অন ডেলিভারি — সাইজ ২-১২ বছর, ম্যাচিং বাবা-ছেলে কালেকশন।">
<link rel="canonical" href="https://almalifestyle.com/p/panjabi-set">
<meta name="viewport" content="width=device-width">
<script type="application/ld+json">{"@type":"Product","name":"Panjabi Set"}</script>
</head><body><h1>ম্যাচিং পাঞ্জাবি</h1>
<img src="/a.jpg" alt="বাবা-ছেলে পাঞ্জাবি"><a href="/p/other">Other</a><a href="https://facebook.com/alma">FB</a>
${'শব্দ '.repeat(200)}
</body></html>`

describe('analyzePageLite', () => {
  it('extracts title/meta/canonical/schema/links from real-ish HTML', () => {
    const s = analyzePageLite(GOOD_HTML, 'https://almalifestyle.com/p/panjabi-set', 200)
    expect(s.title).toContain('পাঞ্জাবি')
    expect(s.metaDescLength).toBeGreaterThan(50)
    expect(s.canonical).toBe('https://almalifestyle.com/p/panjabi-set')
    expect(s.jsonLdTypes).toEqual(['Product'])
    expect(s.h1Count).toBe(1)
    expect(s.internalLinks).toContain('https://almalifestyle.com/p/other')
    expect(s.externalCount).toBe(1)
    expect(s.noindex).toBe(false)
    expect(s.wordCount).toBeGreaterThan(150)
  })

  it('detects noindex and invalid JSON-LD without crashing', () => {
    const html = `<html><head><meta name="robots" content="noindex,follow"><script type="application/ld+json">{bad json</script></head><body></body></html>`
    const s = analyzePageLite(html, 'https://x.com/p', 200)
    expect(s.noindex).toBe(true)
    expect(s.jsonLdTypes).toEqual([])
  })
})

describe('assessIndexability', () => {
  const base: PageSnapshot = analyzePageLite(GOOD_HTML, 'https://almalifestyle.com/p/panjabi-set', 200)

  it('clean 200 self-canonical page is indexable', () => {
    expect(assessIndexability(base)).toEqual({ indexable: true, reasons: [] })
  })

  it('non-200, noindex, and foreign canonical each block with named reasons', () => {
    expect(assessIndexability({ ...base, statusCode: 404 }).reasons.join()).toContain('HTTP 404')
    expect(assessIndexability({ ...base, noindex: true }).reasons.join()).toContain('noindex')
    const foreign = assessIndexability({ ...base, canonical: 'https://almalifestyle.com/p/OTHER' })
    expect(foreign.indexable).toBe(false)
    expect(foreign.reasons.join()).toContain('canonical')
  })
})

describe('buildFindings — decision-grade output', () => {
  it('every finding carries the exit-gate fields; criticals sort first', () => {
    const pages: PageSnapshot[] = [
      analyzePageLite(GOOD_HTML, 'https://x.com/good', 200),
      analyzePageLite('<html><head><meta name="robots" content="noindex"></head><body>short</body></html>', 'https://x.com/hidden', 200),
      analyzePageLite('<html><head></head><body>thin</body></html>', 'https://x.com/thin', 200),
    ]
    const findings = buildFindings(pages)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].severity).toBe('critical')
    for (const f of findings) {
      expect(f.evidence.length).toBeGreaterThan(5)
      expect(f.affectedUrls.length).toBeGreaterThan(0)
      expect(f.expectedImpact.length).toBeGreaterThan(5)
      expect(['high', 'medium', 'low']).toContain(f.confidence)
      expect(f.validation.length).toBeGreaterThan(3)
      expect(f.rollback.length).toBeGreaterThan(1)
      expect(containsRankingGuarantee(`${f.evidence} ${f.expectedImpact}`)).toBe(false)
    }
    expect(findings.some((f) => f.code === 'noindex_pages')).toBe(true)
    expect(findings.some((f) => f.code === 'thin_content')).toBe(true)
  })
})

describe('containsRankingGuarantee — forbidden promises', () => {
  it('catches English and Bangla guarantees; allows honest language', () => {
    expect(containsRankingGuarantee('we guarantee #1 ranking on Google')).toBe(true)
    expect(containsRankingGuarantee('র‍্যাঙ্কিং গ্যারান্টি ১০০%')).toBe(true)
    expect(containsRankingGuarantee('expect CTR uplift over 4 weeks; no ranking promise')).toBe(false)
  })
})

describe('content strategy', () => {
  it('classifies Bangla + English intent', () => {
    expect(classifyIntent('পাঞ্জাবি সেট দাম')).toBe('transactional')
    expect(classifyIntent('best kids panjabi review')).toBe('commercial')
    expect(classifyIntent('alma lifestyle facebook')).toBe('navigational')
    expect(classifyIntent('ঈদে বাচ্চাদের কি পরানো ভালো')).toBe('informational')
  })

  it('clusters by head term, ranks opportunity (pos 5–20 + impressions)', () => {
    const rows: QueryRow[] = [
      { query: 'panjabi set dam', clicks: 5, impressions: 200, ctr: 0.025, position: 8 },
      { query: 'panjabi for kids', clicks: 2, impressions: 150, ctr: 0.013, position: 12 },
      { query: 'shari collection', clicks: 30, impressions: 400, ctr: 0.075, position: 2 },
    ]
    const clusters = buildTopicClusters(rows)
    const panjabi = clusters.find((c) => c.pillar === 'panjabi')!
    expect(panjabi.members).toHaveLength(2)
    expect(panjabi.opportunity).toBe(true)
    const shari = clusters.find((c) => c.pillar === 'shari')!
    expect(shari.opportunity).toBe(false) // already position 2 — not the money zone
    expect(clusters[0].pillar).toBe('panjabi') // opportunity sorts first
  })

  it('content gaps skip covered slugs and label honest impact', () => {
    const clusters = buildTopicClusters([
      { query: 'panjabi set dam', clicks: 5, impressions: 200, ctr: 0.025, position: 8 },
      { query: 'tupi collection', clicks: 1, impressions: 120, ctr: 0.008, position: 15 },
    ])
    const gaps = findContentGaps(clusters, ['/p/panjabi-set'])
    expect(gaps.map((g) => g.pillar)).toEqual(['tupi'])
    expect(gaps[0].reason).toContain('impressions')
  })
})

describe('internal links', () => {
  const pages = [
    { url: 'https://x.com/', internalLinks: ['https://x.com/a', 'https://x.com/b'] },
    { url: 'https://x.com/a', internalLinks: ['https://x.com/b'] },
    { url: 'https://x.com/b', internalLinks: [] },
    { url: 'https://x.com/orphan', internalLinks: ['https://x.com/a'] },
  ]

  it('finds orphans, dead ends, and BFS depth', () => {
    const g = buildLinkGraph(pages, 'https://x.com/')
    expect(g.orphans).toEqual(['https://x.com/orphan'])
    expect(g.deadEnds).toEqual(['https://x.com/b'])
    expect(g.nodes.find((n) => n.url === 'https://x.com/b')!.depth).toBe(1)
    expect(g.nodes.find((n) => n.url === 'https://x.com/orphan')!.depth).toBeNull()
  })

  it('suggests links to orphans first, from high-authority shallow pages', () => {
    const g = buildLinkGraph(pages, 'https://x.com/')
    const s = suggestInternalLinks(g)
    expect(s[0].to).toBe('https://x.com/orphan')
    expect(s[0].priority).toBe('high')
  })
})
