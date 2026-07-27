/**
 * Deliverable quality (owner ruling 2026-07-25): every finished audit produces a
 * live HTML dashboard alongside the markdown report and the issues CSV, and the
 * chat summary states REAL coverage — never the requested page cap.
 */
import { describe, expect, it } from 'vitest'
import { buildClientReportHtml, buildClientReportMarkdown, type AuditJson } from '@/agent/lib/seo-report'

const AUDIT: AuditJson = {
  url: 'https://almatraders.com',
  crawledAt: '2026-07-25T10:00:00.000Z',
  score: 24,
  counts: { critical: 2, high: 3, medium: 1, low: 0 },
  pagesCrawled: 12,
  elapsedMs: 34_000,
  avgTtfbMs: 640,
  sitemap: { ok: true, count: 86 },
  siteChecks: {
    issues: [
      { severity: 'critical', code: 'robots_blocks_all', detail: 'robots.txt পুরো সাইট block করছে!' },
      { severity: 'high', code: 'broken_pages', detail: '3টা ভাঙা পেজ' },
    ],
  },
  pages: [
    {
      url: 'https://almatraders.com/',
      status: 200,
      title: 'ALMA',
      titleLength: 4,
      metaDescLength: 0,
      h1Count: 0,
      wordCount: 90,
      ttfbMs: 610,
      issues: [
        { severity: 'critical', code: 'noindex', detail: 'পেজে noindex' },
        { severity: 'high', code: 'missing_h1', detail: 'H1 নেই' },
        { severity: 'medium', code: 'thin_content', detail: 'খুব কম কনটেন্ট' },
      ],
    },
    {
      url: 'https://almatraders.com/panjabi',
      status: 200,
      title: 'Panjabi',
      titleLength: 7,
      metaDescLength: 0,
      h1Count: 1,
      wordCount: 400,
      ttfbMs: 670,
      issues: [{ severity: 'high', code: 'missing_meta_description', detail: 'meta description নেই' }],
    },
  ],
}

describe('live HTML dashboard', () => {
  const html = buildClientReportHtml(AUDIT)

  it('is a complete self-contained document with no external assets', () => {
    expect(html.startsWith('<!doctype html')).toBe(true)
    expect(html).not.toMatch(/<script\b/i)
    expect(html).not.toMatch(/https?:\/\/[^"' ]*\.(?:js|css|woff2?|png|jpg)/i)
    expect(html).toContain('prefers-color-scheme: dark')
  })

  it('leads with the score and the REAL coverage, not the requested cap', () => {
    expect(html).toContain('>24<')
    expect(html).toContain('12 / 86 (sitemap)')
    expect(html).toContain('34s')
    expect(html).not.toContain('40 পেজ')
  })

  it('carries every issue group with its evidence and fix', () => {
    expect(html).toContain('robots.txt')
    expect(html).toContain('H1')
    expect(html).toContain('করণীয়')
    expect(html).toContain('কেন গুরুত্বপূর্ণ')
  })

  it('escapes untrusted page content instead of injecting it as markup', () => {
    const nasty = buildClientReportHtml({
      ...AUDIT,
      pages: [{ url: 'https://x.com/<img src=x onerror=alert(1)>', status: 200, issues: [] }],
    })
    expect(nasty).not.toContain('<img src=x onerror')
    expect(nasty).toContain('&lt;img src=x onerror')
  })
})

describe('markdown report stays the client deliverable', () => {
  it('still reports the audited page count and issue evidence', () => {
    const md = buildClientReportMarkdown(AUDIT)
    expect(md).toContain('**পেজ পরীক্ষা করা হয়েছে:** 12টা (sitemap-এ মোট 86টা URL)')
    expect(md).toContain('almatraders.com')
    expect(md).toContain('প্রমাণ')
  })
})
