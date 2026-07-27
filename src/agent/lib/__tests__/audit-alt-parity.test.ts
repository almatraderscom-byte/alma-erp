/**
 * OWNER OBSERVATION 2026-07-27 — in one session he got two numbers for one site:
 * the product-level audit said ZERO alt problems, and the site crawl in the same
 * chat reported "12 of 13 images missing alt". He had no way to tell which was
 * lying.
 *
 * The decorative-alt correction from 2026-07-26 — an image the author marked
 * decorative, or one inside an `aria-label`led control, is SUPPOSED to carry
 * `alt=""` — had been applied to the grind page-measure and to the worker
 * crawler, but not to `analyzePageLite`, which is the counter behind the report
 * he reads.
 *
 * These are the exact markup shapes from almatraders.com. The rule is now
 * imported rather than re-implemented, and this test is what stops a fourth copy
 * from drifting.
 */
import { describe, expect, it } from 'vitest'
import { analyzePageLite } from '@/agent/lib/seo/technical-audit'
import { imagesMissingAlt, contentImages } from '@/agent/lib/grind/page-measure'

const page = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`

describe('the site audit counts alt the same way the page measure does', () => {
  it('a thumbnail inside an aria-label button is NOT missing alt', () => {
    const html = page('<button aria-label="কালো পাঞ্জাবি"><img src="/p.jpg" alt=""/></button>')
    expect(analyzePageLite(html, 'https://x/').missingAlt).toBe(0)
  })

  it('a decorative aria-hidden strip is not a defect either', () => {
    const html = page('<div aria-hidden="true"><img src="/d1.png" alt=""/><img src="/d2.png" alt=""/></div>')
    expect(analyzePageLite(html, 'https://x/').missingAlt).toBe(0)
  })

  it('a REAL content image with no alt still counts — this must not go quiet', () => {
    const html = page('<img src="/hero.jpg"/><img src="/p.jpg" alt="নীল পাঞ্জাবি"/>')
    expect(analyzePageLite(html, 'https://x/').missingAlt).toBe(1)
  })

  it('a tracking pixel is not a content image', () => {
    const html = page('<img src="https://facebook.com/tr?id=1" width="1" height="1"/>')
    expect(analyzePageLite(html, 'https://x/').imgCount).toBe(0)
  })

  it('the two counters agree on the mixed page that started this', () => {
    const html = page(
      '<div aria-hidden="true"><img src="/d.png" alt=""/></div>'
      + '<button aria-label="পণ্য"><img src="/t.jpg" alt=""/></button>'
      + '<img src="/hero.jpg"/>'
      + '<img src="/p.jpg" alt="নীল পাঞ্জাবি"/>',
    )
    const lite = analyzePageLite(html, 'https://x/')
    expect(lite.missingAlt).toBe(imagesMissingAlt(html).length)
    expect(lite.imgCount).toBe(contentImages(html).length)
    expect(lite.missingAlt).toBe(1) // only the bare hero
  })
})
