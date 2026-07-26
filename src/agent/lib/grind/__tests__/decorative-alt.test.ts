/**
 * The audit's biggest finding was wrong — 2026-07-26.
 *
 * "মূল সমস্যা: missing_img_alt — প্রায় সব ক্যাটেগরি/প্রোডাক্ট পেজে 12–34টা ছবিতে alt
 * নেই (মোট ৫২+ ছবি প্রভাবিত)। এটা Google Images ট্রাফিক + accessibility ভাঙছে।"
 *
 * Boss ordered the fix. I fetched the live page myself before writing a single
 * alt: every empty-alt image sat inside
 *
 *   <div class="foot-strip" aria-hidden="true"><img src="…" alt=""/>
 *
 * a decorative footer strip. An image marked decorative is SUPPOSED to carry
 * alt="" — that is the accessibility rule, not a violation of it. The finding
 * was a false positive, and the fix would have made the page worse.
 *
 * Finder (worker/src/seo/audit.mjs) and verifier (page-measure) must apply the
 * same rule, or a correct page reads as broken forever.
 */
import { describe, expect, it } from 'vitest'
import { contentImages, imagesMissingAlt } from '@/agent/lib/grind/page-measure'

const REAL_FOOTER = `
<div class="foot-strip" aria-hidden="true">
  <img src="https://awugvcjezittjjgfysuk.supabase.co/storage/v1/object/public/product-images/family-sets/product-code-126/x.png" alt=""/>
  <img src="https://awugvcjezittjjgfysuk.supabase.co/storage/v1/object/public/product-images/family-sets/product-code-276/y.png" alt=""/>
</div>`

const REAL_PRODUCT_IMAGE =
  '<img alt="এ্যাশ কালার পাঞ্জাবী  Product Code: 110 — ALMA Lifestyle" data-nimg="fill" src="/_next/image?url=x"/>'

describe('what counts as an image that needs alt', () => {
  it('ignores the decorative footer strip that triggered the whole false alarm', () => {
    expect(contentImages(REAL_FOOTER)).toHaveLength(0)
  })

  it('still counts the real product image', () => {
    expect(contentImages(REAL_PRODUCT_IMAGE)).toHaveLength(1)
  })

  it('ignores an image that marks itself decorative', () => {
    expect(contentImages('<img src="/a.png" alt="" aria-hidden="true"/>')).toHaveLength(0)
    expect(contentImages('<img src="/a.png" alt="" role="presentation"/>')).toHaveLength(0)
  })

  it('ignores tracking pixels — the Facebook one is on every page', () => {
    expect(contentImages('<img src="https://www.facebook.com/tr?id=42&ev=PageView" alt=""/>')).toHaveLength(0)
    expect(contentImages('<img src="/p.gif" width="1" height="1" alt=""/>')).toHaveLength(0)
  })

  // The homepage's 22 "missing alt" images, all of this shape. They still COUNT
  // as content images (Google Images cares) — they are just not missing a name.
  it('a thumbnail whose button already carries the name is not missing alt', () => {
    const html =
      '<button type="button" class="thumb" aria-label="সি-গ্রীন কালার পাঞ্জাবী Product Code: 126">'
      + '<img src="/thumb.png" alt=""/></button>'
    expect(contentImages(html)).toHaveLength(1)
    expect(imagesMissingAlt(html)).toHaveLength(0)
  })

  it('but an unlabelled button hides nothing — the image still needs alt', () => {
    const html = '<button type="button"><img src="/thumb.png"/></button>'
    expect(contentImages(html)).toHaveLength(1)
    expect(imagesMissingAlt(html)).toHaveLength(1)
  })

  it('a genuinely unlabelled content image is still caught', () => {
    const html = '<main><img src="/products/panjabi.jpg"/></main>'
    const imgs = contentImages(html)
    expect(imgs).toHaveLength(1)
    expect(/alt=/.test(imgs[0])).toBe(false)
  })

  it('the real page: 2 decorative + 1 pixel + 1 labelled = one content image, zero missing', () => {
    const html = `<body>${REAL_PRODUCT_IMAGE}${REAL_FOOTER}<img src="https://www.facebook.com/tr?id=1" alt=""/></body>`
    const imgs = contentImages(html)
    expect(imgs).toHaveLength(1)
    expect(imgs.filter((t) => !/alt="[^"]+"/.test(t))).toHaveLength(0)
  })
})
