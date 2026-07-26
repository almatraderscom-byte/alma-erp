/**
 * Server-side re-measurement of ONE page, emitting the SAME issue codes as the
 * worker crawler (worker/src/seo/audit.mjs `analyzeHtml`).
 *
 * Why this exists: verifying a fix must not mean re-crawling 80 pages. After a
 * batch of page-level fixes we re-measure only the pages we touched, and diff
 * fingerprints. Everything the verifier decides comes from here — never from the
 * model's opinion about its own work.
 *
 * HONEST LIMITS (and how they are contained):
 *  - this is regex/lightweight parsing, not the worker's HTML parser, so an
 *    exotic document could disagree at the margin;
 *  - `thin_content` counts words from stripped markup, which can differ slightly
 *    from the crawler's structuredText;
 *  - SITE-level codes (sitemap, https, broken pages, duplicate titles) are not
 *    measurable per page and are never emitted here.
 * Containment: a campaign always ends with a FULL worker re-crawl, and any
 * finding still sitting at `fix_claimed` blocks completion. So a scoped
 * disagreement can delay "done" — it can never fake it.
 */

export interface PageIssue {
  severity: 'critical' | 'high' | 'medium' | 'low'
  code: string
  detail: string
}

/** Page-level codes this module can decide. Anything else is site-level. */
export const PAGE_LEVEL_CODES: ReadonlySet<string> = new Set([
  'missing_title',
  'short_title',
  'long_title',
  'missing_meta_description',
  'short_meta_description',
  'long_meta_description',
  'missing_h1',
  'multiple_h1',
  'missing_canonical',
  'noindex',
  'missing_viewport',
  'missing_lang',
  'incomplete_open_graph',
  'hreflang_no_xdefault',
  'missing_structured_data',
  'invalid_structured_data',
  'missing_img_alt',
  'thin_content',
  'mixed_content',
])

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  return m ? m[1] : null
}

const tagsOf = (html: string, tagName: string): string[] =>
  html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) ?? []

/**
 * Images that carry meaning — the only ones an empty alt is a defect on.
 *
 * Excluded: anything the author explicitly marked decorative (aria-hidden,
 * role="presentation"), anything inside such a container, and tracking pixels.
 * The owner lost an afternoon to this on 2026-07-26: the audit's headline
 * "52+ images without alt" was a decorative <div aria-hidden="true"> footer
 * strip that was already correct HTML.
 *
 * The container scan is deliberately shallow — a single aria-hidden block up to
 * its next </div>. That covers the real markup; anything cleverer would be a
 * parser, and this file is the cheap mirror of the crawler, not a second one.
 */
export function contentImages(html: string): string[] {
  const stripped = html.replace(/<div\b[^>]*aria-hidden\s*=\s*["']true["'][^>]*>[\s\S]*?<\/div>/gi, '')
  return tagsOf(stripped, 'img').filter((t) => {
    if ((attr(t, 'aria-hidden') ?? '') === 'true') return false
    if ((attr(t, 'role') ?? '') === 'presentation') return false
    const src = attr(t, 'src') ?? ''
    if (/facebook\.com\/tr|\/pixel|analytics|googletagmanager/i.test(src)) return false
    return !((attr(t, 'width') ?? '') === '1' && (attr(t, 'height') ?? '') === '1')
  })
}

function metaContent(html: string, key: 'name' | 'property', value: string): string | null {
  for (const tag of tagsOf(html, 'meta')) {
    const k = attr(tag, key)
    if (k && k.toLowerCase() === value.toLowerCase()) return attr(tag, 'content') ?? ''
  }
  return null
}

function linkHref(html: string, rel: string): string | null {
  for (const tag of tagsOf(html, 'link')) {
    const r = (attr(tag, 'rel') ?? '').toLowerCase()
    if (r.split(/\s+/).includes(rel)) return attr(tag, 'href')
  }
  return null
}

/**
 * The page-level issue list for one fetched document. Mirrors the crawler's
 * thresholds exactly — those numbers are the contract between the two.
 */
export function measurePageIssues(html: string, pageUrl: string): PageIssue[] {
  const issues: PageIssue[] = []
  const add = (severity: PageIssue['severity'], code: string, detail: string) =>
    issues.push({ severity, code, detail })

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? ''
  if (!title) add('critical', 'missing_title', 'কোনো <title> নেই')
  else if (title.length < 10) add('high', 'short_title', `টাইটেল খুব ছোট (${title.length})`)
  else if (title.length > 65) add('medium', 'long_title', `টাইটেল খুব লম্বা (${title.length})`)

  const metaDesc = (metaContent(html, 'name', 'description') ?? '').trim()
  if (!metaDesc) add('high', 'missing_meta_description', 'meta description নেই')
  else if (metaDesc.length < 50) add('medium', 'short_meta_description', `meta description ছোট (${metaDesc.length})`)
  else if (metaDesc.length > 165) add('low', 'long_meta_description', `meta description লম্বা (${metaDesc.length})`)

  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length
  if (h1Count === 0) add('high', 'missing_h1', 'কোনো H1 নেই')
  else if (h1Count > 1) add('low', 'multiple_h1', `${h1Count}টা H1`)

  if (!linkHref(html, 'canonical')) add('medium', 'missing_canonical', 'canonical link নেই')

  const robots = (metaContent(html, 'name', 'robots') ?? '').toLowerCase()
  if (robots.includes('noindex')) add('critical', 'noindex', 'পেজটা noindex — Google-এ আসবে না')

  if (metaContent(html, 'name', 'viewport') === null) {
    add('high', 'missing_viewport', 'mobile viewport meta নেই')
  }

  const htmlTag = /<html\b[^>]*>/i.exec(html)?.[0] ?? ''
  if (!attr(htmlTag, 'lang')) add('low', 'missing_lang', '<html lang> নেই')

  const ogTitle = metaContent(html, 'property', 'og:title')
  const ogImage = metaContent(html, 'property', 'og:image')
  if (ogTitle === null || ogImage === null) {
    add('low', 'incomplete_open_graph', 'og:title/og:image অসম্পূর্ণ (share preview দুর্বল)')
  }

  const hreflangTags = tagsOf(html, 'link').filter(
    (t) => (attr(t, 'rel') ?? '').toLowerCase().includes('alternate') && attr(t, 'hreflang') !== null,
  )
  if (hreflangTags.length > 0) {
    const hasXDefault = hreflangTags.some((t) => (attr(t, 'hreflang') ?? '').toLowerCase() === 'x-default')
    if (!hasXDefault) add('low', 'hreflang_no_xdefault', `${hreflangTags.length}টা hreflang আছে কিন্তু x-default নেই`)
  }

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
  if (jsonLdTypes.length === 0) add('medium', 'missing_structured_data', 'কোনো schema.org (JSON-LD) নেই')
  if (jsonLdTypes.includes('INVALID')) add('medium', 'invalid_structured_data', 'JSON-LD ভাঙা')

  // Same rule as the crawler (worker/src/seo/audit.mjs): a decorative image is
  // SUPPOSED to carry alt="". The verifier must agree with the finder, or a
  // correct page reads as broken forever.
  const imgs = contentImages(html)
  const missingAlt = imgs.filter((t) => !(attr(t, 'alt') ?? '').trim()).length
  if (imgs.length > 0 && missingAlt > 0) {
    add(
      missingAlt > imgs.length / 2 ? 'medium' : 'low',
      'missing_img_alt',
      `${imgs.length}টা কনটেন্ট ছবির মধ্যে ${missingAlt}টায় alt নেই`,
    )
  }

  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length
  if (wordCount < 150) add('medium', 'thin_content', `কনটেন্ট পাতলা (${wordCount} শব্দ)`)

  if (pageUrl.startsWith('https://')) {
    const mixed = html.match(/(src|href)=["']http:\/\//g)?.length ?? 0
    if (mixed > 0) add('high', 'mixed_content', `${mixed}টা http:// রিসোর্স https পেজে`)
  }

  return issues
}

/**
 * Refuse anything that is not a public http(s) page. The re-measure fetches
 * whatever URL a finding carries, so the same SSRF posture as the crawler
 * applies here — private ranges and non-http schemes are never fetched.
 */
export function unsafeMeasureUrlReason(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'URL পড়া যায়নি'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'শুধু http/https চলবে'
  if (u.port && !['', '80', '443'].includes(u.port)) return 'শুধু ডিফল্ট পোর্ট চলবে'
  const host = u.hostname.toLowerCase()
  if (
    host === 'localhost'
    || host.endsWith('.internal')
    || host.endsWith('.local')
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host === '::1'
  ) {
    return 'ভেতরের/প্রাইভেট ঠিকানা — ক্রল করা হবে না'
  }
  return null
}
