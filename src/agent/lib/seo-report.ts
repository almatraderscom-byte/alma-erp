/**
 * Client-grade SEO report builder — owner request 2026-07-11.
 *
 * The VPS worker (worker/src/seo/audit.mjs) writes a bare-bones report.md next
 * to audit.json. The owner hands these reports to paying CLIENTS before closing
 * a deal, so the deliverable must be a properly structured document: executive
 * summary, category scorecard, every issue with EVIDENCE (the actual value
 * found on the actual page), why it matters, and the concrete fix — nothing
 * dropped. This module rebuilds that document server-side from audit.json, so
 * report quality ships from Vercel without needing a VPS worker redeploy.
 *
 * Also builds the BEFORE/AFTER comparison (two audits of the same site) the
 * owner sends as proof after doing the client's fixes.
 *
 * All output is Bangla markdown (the client-facing language of the business).
 */

export type AuditIssue = { severity: 'critical' | 'high' | 'medium' | 'low'; code: string; detail: string }

export type AuditPage = {
  url: string
  status?: number
  title?: string
  titleLength?: number
  metaDesc?: string
  metaDescLength?: number
  h1Count?: number
  canonical?: string | null
  noindex?: boolean
  jsonLdTypes?: string[]
  imgCount?: number
  missingAlt?: number
  wordCount?: number
  externalCount?: number
  ttfbMs?: number
  bytes?: number
  compressed?: boolean
  issues?: AuditIssue[]
}

export type AuditJson = {
  url: string
  crawledAt?: string
  score: number
  counts: { critical: number; high: number; medium: number; low: number }
  siteChecks?: { issues?: AuditIssue[] }
  sitemap?: { ok: boolean; count: number }
  pages?: AuditPage[]
}

const SEV_BN: Record<string, string> = {
  critical: '🔴 জরুরি (Critical)',
  high: '🟠 গুরুতর (High)',
  medium: '🟡 মাঝারি (Medium)',
  low: '⚪ ছোট (Low)',
}
const SEV_ORDER = ['critical', 'high', 'medium', 'low'] as const

/**
 * Knowledge base: issue code → client-readable name, why it matters, the fix,
 * and how to pull page-level EVIDENCE for it. Every code the worker can emit
 * is covered; unknown codes fall back to the raw detail so nothing is dropped.
 */
type IssueInfo = {
  name: string
  why: string
  fix: string
  evidence?: (p: AuditPage, detail: string) => string
}

const quote = (s: string | undefined, max = 90) => {
  const t = (s ?? '').trim()
  if (!t) return '—'
  return `"${t.length > max ? `${t.slice(0, max)}…` : t}"`
}

const ISSUE_KB: Record<string, IssueInfo> = {
  // ---- page-level -----------------------------------------------------------
  missing_title: {
    name: 'পেজ টাইটেল নেই',
    why: 'টাইটেলই Google-এ সার্চ রেজাল্টের নীল হেডলাইন — এটা ছাড়া পেজ র‍্যাংক করা প্রায় অসম্ভব।',
    fix: 'প্রতিটি পেজে ৩০–৬০ অক্ষরের ইউনিক <title> দিন — মূল কীওয়ার্ড + ব্র্যান্ড নাম।',
    evidence: () => 'পেজে <title> ট্যাগই পাওয়া যায়নি',
  },
  short_title: {
    name: 'টাইটেল খুব ছোট',
    why: 'ছোট টাইটেল কীওয়ার্ড ধরতে পারে না, সার্চে ক্লিকও কম আসে।',
    fix: 'টাইটেল ৩০–৬০ অক্ষরে বাড়ান — সার্ভিস/প্রোডাক্ট + লোকেশন + ব্র্যান্ড।',
    evidence: (p) => `বর্তমান টাইটেল: ${quote(p.title)} (${p.titleLength ?? 0} অক্ষর)`,
  },
  long_title: {
    name: 'টাইটেল খুব লম্বা',
    why: '৬৫ অক্ষরের পর Google টাইটেল কেটে "…" দেখায় — মেসেজ অসম্পূর্ণ দেখায়।',
    fix: 'টাইটেল ৬০ অক্ষরের মধ্যে আনুন; সবচেয়ে দরকারি কথাটা শুরুতে দিন।',
    evidence: (p) => `বর্তমান টাইটেল: ${quote(p.title)} (${p.titleLength ?? 0} অক্ষর)`,
  },
  missing_meta_description: {
    name: 'Meta description নেই',
    why: 'সার্চ রেজাল্টে টাইটেলের নিচের বর্ণনা এটাই — না থাকলে Google নিজে যা খুশি দেখায়, ক্লিক-রেট কমে।',
    fix: 'প্রতিটি পেজে ৭০–১৬০ অক্ষরের ইউনিক meta description লিখুন — কী পাবেন + কেন এখানেই।',
    evidence: () => 'পেজে meta description ট্যাগ নেই',
  },
  short_meta_description: {
    name: 'Meta description খুব ছোট',
    why: 'ছোট বর্ণনা সার্চে জায়গা নষ্ট করে — বোঝানোর সুযোগটাই হারায়।',
    fix: 'বর্ণনা ৭০–১৬০ অক্ষরে বাড়ান, কল-টু-অ্যাকশন সহ।',
    evidence: (p) => `বর্তমান description: ${quote(p.metaDesc)} (${p.metaDescLength ?? 0} অক্ষর)`,
  },
  long_meta_description: {
    name: 'Meta description খুব লম্বা',
    why: '১৬০+ অক্ষরে Google কেটে দেয়।',
    fix: 'description ১৬০ অক্ষরের মধ্যে আনুন।',
    evidence: (p) => `বর্তমান description: ${quote(p.metaDesc)} (${p.metaDescLength ?? 0} অক্ষর)`,
  },
  missing_h1: {
    name: 'H1 হেডিং নেই',
    why: 'H1 পেজের মূল বিষয় Google-কে বলে — না থাকলে পেজের টপিক অস্পষ্ট থাকে।',
    fix: 'প্রতিটি পেজে ঠিক ১টা H1 দিন, মূল কীওয়ার্ড সহ।',
    evidence: () => 'পেজে কোনো <h1> নেই',
  },
  multiple_h1: {
    name: 'একাধিক H1',
    why: 'একাধিক H1 থাকলে পেজের মূল বিষয় Google-এর কাছে ঘোলাটে হয়।',
    fix: '১টা H1 রাখুন; বাকিগুলো H2/H3 করুন।',
    evidence: (p) => `পেজে ${p.h1Count ?? '?'}টা H1 পাওয়া গেছে`,
  },
  missing_canonical: {
    name: 'Canonical লিংক নেই',
    why: 'একই কনটেন্ট একাধিক URL-এ খুললে canonical ছাড়া Google duplicate ধরে র‍্যাংক ভাগ হয়ে যায়।',
    fix: 'প্রতিটি পেজে <link rel="canonical"> দিয়ে আসল URL ঘোষণা করুন।',
    evidence: () => 'পেজে rel="canonical" ট্যাগ নেই',
  },
  noindex: {
    name: 'পেজ noindex করা — Google-এ আসবেই না',
    why: 'noindex মানে পেজটা Google-কে সরাসরি বলা হচ্ছে "আমাকে সার্চে দেখিও না"।',
    fix: 'ভুলবশত noindex হলে meta robots থেকে noindex সরান — এটা সবার আগে ঠিক করতে হবে।',
    evidence: () => 'meta robots-এ "noindex" পাওয়া গেছে',
  },
  missing_viewport: {
    name: 'Mobile viewport meta নেই',
    why: 'Google mobile-first ইনডেক্স করে — viewport ছাড়া পেজ মোবাইলে ভাঙা দেখায়, র‍্যাংক পড়ে।',
    fix: '<meta name="viewport" content="width=device-width, initial-scale=1"> যোগ করুন।',
    evidence: () => 'পেজে viewport meta নেই',
  },
  missing_lang: {
    name: '<html lang> নেই',
    why: 'ভাষা ঘোষণা না থাকলে সার্চ ইঞ্জিন/স্ক্রিন-রিডার ভাষা ধরতে পারে না।',
    fix: '<html lang="bn"> (বা সাইটের ভাষা অনুযায়ী) দিন।',
    evidence: () => '<html> ট্যাগে lang attribute নেই',
  },
  incomplete_open_graph: {
    name: 'Open Graph অসম্পূর্ণ (share preview দুর্বল)',
    why: 'Facebook/WhatsApp-এ লিংক শেয়ার করলে ছবি-টাইটেল ছাড়া ফ্যাকাশে প্রিভিউ আসে — ক্লিক কমে।',
    fix: 'og:title, og:description, og:image (১২০০×৬৩০) প্রতিটি পেজে দিন।',
    evidence: () => 'og:title বা og:image নেই',
  },
  missing_structured_data: {
    name: 'Structured data (schema.org) নেই',
    why: 'Schema ছাড়া রিভিউ-স্টার, প্রাইস, FAQ-এর মতো rich result পাওয়া যায় না।',
    fix: 'ব্যবসার ধরন অনুযায়ী JSON-LD দিন (LocalBusiness / Product / Service + Organization)।',
    evidence: () => 'পেজে কোনো JSON-LD স্ক্রিপ্ট নেই',
  },
  invalid_structured_data: {
    name: 'Structured data ভাঙা',
    why: 'ভাঙা JSON-LD Google পড়তে পারে না — থেকেও কোনো লাভ হচ্ছে না।',
    fix: 'Google Rich Results Test দিয়ে JSON-LD ভ্যালিডেট করে ঠিক করুন।',
    evidence: (p) => `পেজের JSON-LD parse হয় না (পাওয়া types: ${p.jsonLdTypes?.join(', ') || 'নেই'})`,
  },
  missing_img_alt: {
    name: 'ছবির alt টেক্সট নেই',
    why: 'alt ছাড়া Google Images থেকে ট্র্যাফিক আসে না, accessibility-ও ভাঙে।',
    fix: 'প্রতিটি অর্থবহ ছবিতে বর্ণনামূলক alt দিন (কীওয়ার্ড স্বাভাবিকভাবে)।',
    evidence: (p) => `${p.imgCount ?? '?'}টা ছবির মধ্যে ${p.missingAlt ?? '?'}টায় alt নেই`,
  },
  thin_content: {
    name: 'কনটেন্ট পাতলা',
    why: '১৫০ শব্দের কম কনটেন্টকে Google "thin" ধরে — র‍্যাংক করার মতো তথ্যই নেই।',
    fix: 'পেজে ৩০০+ শব্দের কাজের কনটেন্ট দিন — সার্ভিস বর্ণনা, FAQ, লোকেশন তথ্য।',
    evidence: (p) => `পেজে মাত্র ${p.wordCount ?? '?'} শব্দ`,
  },
  mixed_content: {
    name: 'Mixed content (https পেজে http রিসোর্স)',
    why: 'ব্রাউজার "Not secure" সতর্কতা দেখায়, কিছু রিসোর্স ব্লকও হয় — বিশ্বাস নষ্ট।',
    fix: 'সব ছবি/স্ক্রিপ্ট/CSS লিংক https:// করুন।',
    evidence: (_p, detail) => detail,
  },
  // ---- site-level -----------------------------------------------------------
  no_https: {
    name: 'সাইট https-এ নেই',
    why: 'http সাইটে ব্রাউজার "Not secure" দেখায়; Google-ও https-কে র‍্যাংকিং সিগনাল ধরে।',
    fix: 'SSL সার্টিফিকেট বসিয়ে পুরো সাইট https করুন (হোস্টিং থেকে ফ্রি Let\'s Encrypt হয়)।',
  },
  http_not_redirected: {
    name: 'http → https redirect নেই',
    why: 'সাইট দুই ঠিকানায় খোলে (http + https) — Google-এর চোখে duplicate সাইট, র‍্যাংক ভাগ হয়।',
    fix: 'সার্ভারে http থেকে https-এ 301 redirect বসান।',
  },
  long_redirect_chain: {
    name: 'লম্বা redirect chain',
    why: 'প্রতিটি redirect ধাপ লোডিং ধীর করে, crawl budget নষ্ট করে।',
    fix: 'redirect গুলো এক ধাপে (সরাসরি final URL-এ) আনুন।',
  },
  missing_robots: {
    name: 'robots.txt নেই',
    why: 'robots.txt সার্চ-বটকে গাইড করে ও sitemap-এর ঠিকানা দেয়।',
    fix: 'সাইট-রুটে robots.txt দিন, ভেতরে Sitemap: লাইন সহ।',
  },
  robots_blocks_all: {
    name: 'robots.txt পুরো সাইট ব্লক করছে!',
    why: 'Disallow: / মানে Google-কে পুরো সাইট crawl করতে নিষেধ — সার্চে সাইট মুছে যাবে।',
    fix: 'robots.txt থেকে "Disallow: /" এখনই সরান — এটা সবচেয়ে জরুরি ফিক্স।',
  },
  missing_sitemap: {
    name: 'sitemap.xml নেই',
    why: 'sitemap ছাড়া Google নতুন/গভীর পেজ খুঁজে পেতে দেরি করে।',
    fix: 'sitemap.xml জেনারেট করে robots.txt-এ লিংক দিন ও Search Console-এ জমা দিন।',
  },
  duplicate_titles: {
    name: 'ডুপ্লিকেট টাইটেল',
    why: 'একাধিক পেজের হুবহু এক টাইটেল — Google বোঝে না কোনটা দেখাবে, দুটোই দুর্বল হয়।',
    fix: 'প্রতিটি পেজে ইউনিক টাইটেল দিন।',
  },
  duplicate_descriptions: {
    name: 'ডুপ্লিকেট meta description',
    why: 'এক বর্ণনা সব পেজে — সার্চ রেজাল্টে পেজগুলো আলাদা করে চেনা যায় না।',
    fix: 'প্রতিটি পেজে ইউনিক description দিন।',
  },
  broken_pages: {
    name: 'ভাঙা পেজ (4xx/5xx) internal link থেকে',
    why: 'নিজের সাইটের লিংক ভাঙা পেজে গেলে ভিজিটর ও Google দুজনেই হোঁচট খায়।',
    fix: 'ভাঙা লিংক ঠিক করুন বা 301 redirect দিন (তালিকা নিচে পেজ-ধরে আছে)।',
  },
  slow_ttfb: {
    name: 'সার্ভার ধীর (TTFB > 1.5s)',
    why: 'স্পিড সরাসরি র‍্যাংকিং ফ্যাক্টর; ধীর সাইটে ভিজিটর অর্ধেক পথেই চলে যায়।',
    fix: 'ক্যাশিং/CDN বসান, হোস্টিং আপগ্রেড ভাবুন, ভারী প্লাগইন কমান।',
  },
  moderate_ttfb: {
    name: 'সার্ভার মাঝারি ধীর (TTFB > 0.8s)',
    why: 'আরেকটু দ্রুত হলে ইউজার-এক্সপিরিয়েন্স ও র‍্যাংক দুটোই ভালো হয়।',
    fix: 'পেজ-ক্যাশিং চালু করুন; ছবি অপ্টিমাইজ করুন।',
  },
  no_compression: {
    name: 'gzip/brotli compression বন্ধ',
    why: 'compression ছাড়া পেজ ৩–৫ গুণ বড় হয়ে ডাউনলোড হয় — খামোখা ধীর।',
    fix: 'সার্ভারে gzip বা brotli compression চালু করুন (এক লাইনের কনফিগ)।',
  },
}

function issueInfo(code: string, detail: string): IssueInfo {
  if (ISSUE_KB[code]) return ISSUE_KB[code]
  if (/^http_(\d{3})$/.test(code)) {
    const status = code.slice(5)
    return {
      name: `পেজ ভাঙা — HTTP ${status}`,
      why: 'সাইটের internal link এই পেজে পাঠায় কিন্তু পেজ খোলে না — ভিজিটর ও Google দুজনেই আটকে যায়।',
      fix: 'পেজটা ঠিক করুন, নয়তো লিংক সরান বা সঠিক পেজে 301 redirect দিন।',
      evidence: () => `HTTP ${status} রেসপন্স`,
    }
  }
  return { name: code, why: detail, fix: 'বিস্তারিত raw findings (audit.json)-এ দেখুন।', evidence: (_p, d) => d }
}

function grade(score: number): string {
  if (score >= 90) return 'A (চমৎকার)'
  if (score >= 75) return 'B (ভালো, কিছু কাজ বাকি)'
  if (score >= 60) return 'C (মাঝারি — উন্নতির জায়গা স্পষ্ট)'
  if (score >= 40) return 'D (দুর্বল — দ্রুত কাজ দরকার)'
  return 'F (জরুরি অবস্থা — এখনই কাজ শুরু করা উচিত)'
}

const CATEGORY_OF: Record<string, string> = {
  noindex: 'ইনডেক্সিং', robots_blocks_all: 'ইনডেক্সিং', missing_robots: 'ইনডেক্সিং', missing_sitemap: 'ইনডেক্সিং',
  no_https: 'নিরাপত্তা ও টেকনিক্যাল', http_not_redirected: 'নিরাপত্তা ও টেকনিক্যাল', mixed_content: 'নিরাপত্তা ও টেকনিক্যাল',
  long_redirect_chain: 'নিরাপত্তা ও টেকনিক্যাল', broken_pages: 'নিরাপত্তা ও টেকনিক্যাল',
  missing_title: 'অন-পেজ SEO', short_title: 'অন-পেজ SEO', long_title: 'অন-পেজ SEO',
  missing_meta_description: 'অন-পেজ SEO', short_meta_description: 'অন-পেজ SEO', long_meta_description: 'অন-পেজ SEO',
  missing_h1: 'অন-পেজ SEO', multiple_h1: 'অন-পেজ SEO', missing_canonical: 'অন-পেজ SEO', missing_lang: 'অন-পেজ SEO',
  duplicate_titles: 'অন-পেজ SEO', duplicate_descriptions: 'অন-পেজ SEO',
  thin_content: 'কনটেন্ট', missing_img_alt: 'কনটেন্ট',
  incomplete_open_graph: 'সোশ্যাল ও schema', missing_structured_data: 'সোশ্যাল ও schema', invalid_structured_data: 'সোশ্যাল ও schema',
  slow_ttfb: 'স্পিড', moderate_ttfb: 'স্পিড', no_compression: 'স্পিড',
}
const CATEGORIES = ['ইনডেক্সিং', 'নিরাপত্তা ও টেকনিক্যাল', 'অন-পেজ SEO', 'কনটেন্ট', 'সোশ্যাল ও schema', 'স্পিড'] as const

const categoryOf = (code: string) => CATEGORY_OF[code] ?? (/^http_\d{3}$/.test(code) ? 'নিরাপত্তা ও টেকনিক্যাল' : 'অন্যান্য')

const fmtDate = (iso?: string) => {
  const d = iso ? new Date(iso) : new Date()
  return d.toLocaleDateString('bn-BD', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Dhaka' })
}

const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const bnNum = (n: number) => String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)])

type FlatIssue = AuditIssue & { scope: string; page: AuditPage | null }

function flattenIssues(audit: AuditJson): FlatIssue[] {
  const out: FlatIssue[] = []
  for (const i of audit.siteChecks?.issues ?? []) out.push({ ...i, scope: 'site', page: null })
  for (const p of audit.pages ?? []) for (const i of p.issues ?? []) out.push({ ...i, scope: p.url, page: p })
  return out
}

/** The client-deliverable audit report (Bangla markdown). */
export function buildClientReportMarkdown(audit: AuditJson, opts?: { keywordsNote?: string | null; preparedBy?: string }): string {
  const pages = audit.pages ?? []
  const all = flattenIssues(audit)
  const total = all.length
  const L: string[] = []
  const push = (...s: string[]) => L.push(...s)

  // ---- cover ---------------------------------------------------------------
  push(
    `# ওয়েবসাইট SEO অডিট রিপোর্ট`,
    '',
    `**সাইট:** ${audit.url}`,
    `**অডিটের তারিখ:** ${fmtDate(audit.crawledAt)}`,
    `**পেজ পরীক্ষা করা হয়েছে:** ${pages.length}টা`,
    `**প্রস্তুত করেছে:** ${opts?.preparedBy ?? 'ALMA Digital — AI-চালিত পূর্ণাঙ্গ সাইট ক্রল ও বিশ্লেষণ'}`,
    '',
    '---',
    '',
  )

  // ---- executive summary ----------------------------------------------------
  const c = audit.counts
  push(
    `## ১. এক নজরে ফলাফল`,
    '',
    `### সামগ্রিক স্কোর: ${audit.score}/100 — গ্রেড ${grade(audit.score)}`,
    '',
    `মোট **${total}টা সমস্যা** পাওয়া গেছে: 🔴 জরুরি ${c.critical}টা · 🟠 গুরুতর ${c.high}টা · 🟡 মাঝারি ${c.medium}টা · ⚪ ছোট ${c.low}টা`,
    '',
  )
  // top problems: heaviest severity, most-affected codes
  const byCode = new Map<string, FlatIssue[]>()
  for (const i of all) {
    const k = `${i.severity}|${i.code}`
    byCode.set(k, [...(byCode.get(k) ?? []), i])
  }
  const ranked = [...byCode.entries()].sort((a, b) => {
    const sa = SEV_ORDER.indexOf(a[1][0].severity)
    const sb = SEV_ORDER.indexOf(b[1][0].severity)
    return sa === sb ? b[1].length - a[1].length : sa - sb
  })
  if (ranked.length > 0) {
    push(`**সবচেয়ে বড় ${Math.min(3, ranked.length)}টা সমস্যা:**`, '')
    for (const [, items] of ranked.slice(0, 3)) {
      const info = issueInfo(items[0].code, items[0].detail)
      push(`- ${SEV_BN[items[0].severity].split(' ')[0]} **${info.name}** — ${items.length}টা জায়গায়। ${info.why}`)
    }
    push('')
  } else {
    push('✅ উল্লেখযোগ্য কোনো সমস্যা পাওয়া যায়নি — সাইটের SEO ভিত শক্ত।', '')
  }

  // ---- category scorecard ----------------------------------------------------
  push(`## ২. বিভাগভিত্তিক স্কোরকার্ড`, '', `| বিভাগ | অবস্থা | পাওয়া সমস্যা |`, `|---|---|---|`)
  for (const cat of CATEGORIES) {
    const items = all.filter((i) => categoryOf(i.code) === cat)
    const worst = SEV_ORDER.find((s) => items.some((i) => i.severity === s))
    const status = items.length === 0 ? '✅ ঠিক আছে' : `${SEV_BN[worst!].split(' ')[0]} ${items.length}টা সমস্যা`
    const codes = [...new Set(items.map((i) => issueInfo(i.code, i.detail).name))].slice(0, 3).join('; ')
    push(`| ${cat} | ${status} | ${mdCell(codes || '—')} |`)
  }
  push('')

  // ---- site-level health check -----------------------------------------------
  const siteCodes = new Set((audit.siteChecks?.issues ?? []).map((i) => i.code))
  push(
    `## ৩. সাইট-লেভেল হেলথ চেক`,
    '',
    `| পরীক্ষা | ফলাফল |`,
    `|---|---|`,
    `| HTTPS (নিরাপদ সংযোগ) | ${siteCodes.has('no_https') ? '❌ নেই' : '✅ আছে'} |`,
    `| http → https redirect | ${siteCodes.has('http_not_redirected') ? '❌ নেই (সাইট দুই ঠিকানায় খোলে)' : '✅ ঠিক আছে'} |`,
    `| robots.txt | ${siteCodes.has('robots_blocks_all') ? '❌ পুরো সাইট ব্লক করছে!' : siteCodes.has('missing_robots') ? '❌ নেই' : '✅ আছে'} |`,
    `| sitemap.xml | ${audit.sitemap?.ok ? `✅ আছে (${audit.sitemap.count}টা URL)` : '❌ নেই / পড়া যায়নি'} |`,
    `| ভাঙা internal পেজ | ${siteCodes.has('broken_pages') ? `❌ ${(audit.siteChecks?.issues ?? []).find((i) => i.code === 'broken_pages')?.detail ?? 'আছে'}` : '✅ পাওয়া যায়নি'} |`,
    `| সার্ভার স্পিড (গড় TTFB) | ${siteCodes.has('slow_ttfb') ? '❌ ধীর (>1.5s)' : siteCodes.has('moderate_ttfb') ? '⚠️ মাঝারি (>0.8s)' : '✅ ভালো'} |`,
    `| Compression (gzip/br) | ${siteCodes.has('no_compression') ? '❌ বন্ধ' : '✅ চালু'} |`,
    '',
  )

  // ---- detailed findings with evidence ----------------------------------------
  push(`## ৪. বিস্তারিত সমস্যা ও প্রমাণ`, '', `প্রতিটি সমস্যার সাথে **কোন পেজে, ঠিক কী পাওয়া গেছে** (প্রমাণ) এবং **কী করতে হবে** দেওয়া হলো — কোনো পয়েন্ট বাদ নেই; পুরো কাঁচা ডেটা audit.json ফাইলে সংরক্ষিত।`, '')
  let section = 0
  for (const sev of SEV_ORDER) {
    const sevGroups = ranked.filter(([, items]) => items[0].severity === sev)
    if (sevGroups.length === 0) continue
    push(`### ${SEV_BN[sev]}`, '')
    for (const [, items] of sevGroups) {
      section += 1
      const info = issueInfo(items[0].code, items[0].detail)
      push(
        `#### ৪.${bnNum(section)} ${info.name} — ${items.length}টা জায়গায়`,
        '',
        `- **কেন গুরুত্বপূর্ণ:** ${info.why}`,
        `- **করণীয়:** ${info.fix}`,
        '',
        `| পেজ | প্রমাণ (যা পাওয়া গেছে) |`,
        `|---|---|`,
      )
      const CAP = 15
      for (const it of items.slice(0, CAP)) {
        const ev = it.page && info.evidence ? info.evidence(it.page, it.detail) : it.detail
        push(`| ${it.scope === 'site' ? 'পুরো সাইট' : mdCell(it.scope)} | ${mdCell(ev)} |`)
      }
      if (items.length > CAP) push(`| … | আরো ${items.length - CAP}টা — সম্পূর্ণ তালিকা issues.csv / audit.json-এ |`)
      push('')
    }
  }
  if (total === 0) push('✅ কোনো সমস্যা পাওয়া যায়নি।', '')

  // ---- keyword context ---------------------------------------------------------
  if (opts?.keywordsNote) push(`## ৫. কীওয়ার্ড প্রেক্ষাপট`, '', opts.keywordsNote, '')

  // ---- page inventory ------------------------------------------------------------
  push(
    `## ${opts?.keywordsNote ? '৬' : '৫'}. পেজ ইনভেন্টরি (পরীক্ষিত সব পেজ)`,
    '',
    `| পেজ | HTTP | টাইটেল (অক্ষর) | Meta desc | H1 | শব্দ | TTFB | সমস্যা |`,
    `|---|---|---|---|---|---|---|---|`,
  )
  const INV_CAP = 60
  for (const p of pages.slice(0, INV_CAP)) {
    push(
      `| ${mdCell(p.url)} | ${p.status ?? '—'} | ${p.titleLength ?? 0} | ${p.metaDescLength ?? 0} | ${p.h1Count ?? 0} | ${p.wordCount ?? '—'} | ${p.ttfbMs != null ? `${p.ttfbMs}ms` : '—'} | ${p.issues?.length ?? 0} |`,
    )
  }
  if (pages.length > INV_CAP) push(`| … আরো ${pages.length - INV_CAP}টা পেজ (audit.json-এ) | | | | | | | |`)
  push('')

  // ---- action plan -----------------------------------------------------------------
  const has = (sev: string) => all.some((i) => i.severity === sev)
  push(`## অগ্রাধিকারভিত্তিক অ্যাকশন প্ল্যান`, '')
  let phase = 0
  if (has('critical')) {
    phase += 1
    push(`**ধাপ ${bnNum(phase)} — এই সপ্তাহেই (জরুরি):** ${[...new Set(all.filter((i) => i.severity === 'critical').map((i) => issueInfo(i.code, i.detail).name))].join('; ')}। এগুলো ঠিক না হলে বাকি সব কাজ বৃথা।`, '')
  }
  if (has('high')) {
    phase += 1
    push(`**ধাপ ${bnNum(phase)} — প্রথম ২ সপ্তাহ (গুরুতর):** ${[...new Set(all.filter((i) => i.severity === 'high').map((i) => issueInfo(i.code, i.detail).name))].join('; ')}।`, '')
  }
  if (has('medium')) {
    phase += 1
    push(`**ধাপ ${bnNum(phase)} — প্রথম মাস (মাঝারি):** ${[...new Set(all.filter((i) => i.severity === 'medium').map((i) => issueInfo(i.code, i.detail).name))].join('; ')}।`, '')
  }
  if (has('low')) {
    phase += 1
    push(`**ধাপ ${bnNum(phase)} — চলমান পলিশ:** ${[...new Set(all.filter((i) => i.severity === 'low').map((i) => issueInfo(i.code, i.detail).name))].join('; ')}।`, '')
  }
  push(`কাজ শেষে **আবার অডিট চালিয়ে আগে-পরে তুলনার রিপোর্ট** দেওয়া হবে — স্কোর ও প্রতিটি সমাধান হওয়া সমস্যার প্রমাণসহ।`, '')

  // ---- methodology -------------------------------------------------------------------
  push(
    `## পদ্ধতি ও প্রমাণ`,
    '',
    `- পুরো সাইট read-only ক্রল করা হয়েছে (কোনো ফর্ম/লগইন নয়) — প্রতিটি পেজের HTML সরাসরি ডাউনলোড করে ${pages.length}টা পেজে ২০+ ধরনের পরীক্ষা চালানো হয়েছে।`,
    `- প্রতিটি সমস্যার পাশে পেজের URL ও মাপা মান (প্রমাণ) দেওয়া আছে; সম্পূর্ণ কাঁচা ডেটা **audit.json** ও সব সমস্যার Excel তালিকা **issues.csv** ফাইলে।`,
    `- স্কোরিং: জরুরি সমস্যা −15, গুরুতর −6, মাঝারি −2, ছোট −0.5 করে 100 থেকে।`,
    '',
    `_ALMA Digital · স্বয়ংক্রিয় SEO অডিট · ${fmtDate(audit.crawledAt)}_`,
  )
  return L.join('\n')
}

/** Issues CSV (Excel-openable) with evidence + fix columns. */
export function buildIssuesCsv(audit: AuditJson): string {
  const esc = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const rows = [['scope', 'severity', 'issue', 'code', 'evidence', 'fix'].join(',')]
  for (const i of flattenIssues(audit)) {
    const info = issueInfo(i.code, i.detail)
    const ev = i.page && info.evidence ? info.evidence(i.page, i.detail) : i.detail
    rows.push([esc(i.scope), esc(i.severity), esc(info.name), esc(i.code), esc(ev), esc(info.fix)].join(','))
  }
  // UTF-8 BOM so Excel renders the Bangla columns correctly.
  return '\ufeff' + rows.join('\n')
}

/** Before/after comparison report — the proof file the owner sends a client after fixes. */
export function buildCompareMarkdown(before: AuditJson, after: AuditJson): string {
  const key = (i: FlatIssue) => `${i.scope}|${i.code}`
  const beforeIssues = flattenIssues(before)
  const afterIssues = flattenIssues(after)
  const afterKeys = new Set(afterIssues.map(key))
  const beforeKeys = new Set(beforeIssues.map(key))
  const resolved = beforeIssues.filter((i) => !afterKeys.has(key(i)))
  const introduced = afterIssues.filter((i) => !beforeKeys.has(key(i)))
  const remaining = afterIssues.filter((i) => beforeKeys.has(key(i)))
  const delta = after.score - before.score
  const arrow = delta > 0 ? `📈 +${delta}` : delta < 0 ? `📉 ${delta}` : '➡️ অপরিবর্তিত'

  const L: string[] = [
    `# SEO উন্নতির রিপোর্ট — আগে বনাম পরে`,
    '',
    `**সাইট:** ${after.url}`,
    `**আগের অডিট:** ${fmtDate(before.crawledAt)} · **পরের অডিট:** ${fmtDate(after.crawledAt)}`,
    '',
    `## স্কোর: ${before.score}/100 → **${after.score}/100** (${arrow})`,
    '',
    `| | আগে | পরে | পরিবর্তন |`,
    `|---|---|---|---|`,
  ]
  for (const sev of SEV_ORDER) {
    const b = before.counts[sev] ?? 0
    const a = after.counts[sev] ?? 0
    L.push(`| ${SEV_BN[sev]} | ${b} | ${a} | ${a < b ? `✅ −${b - a}` : a > b ? `⚠️ +${a - b}` : '—'} |`)
  }
  L.push(`| মোট সমস্যা | ${beforeIssues.length} | ${afterIssues.length} | ${afterIssues.length < beforeIssues.length ? `✅ −${beforeIssues.length - afterIssues.length}` : afterIssues.length > beforeIssues.length ? `⚠️ +${afterIssues.length - beforeIssues.length}` : '—'} |`, '')

  L.push(`## ✅ সমাধান হয়েছে (${resolved.length}টা) — প্রমাণসহ`, '')
  if (resolved.length === 0) L.push('- এই দুই অডিটের মধ্যে কোনো সমস্যা সমাধান হয়নি।', '')
  else {
    L.push(`| সমস্যা | কোথায় | আগের অবস্থা (প্রমাণ) |`, `|---|---|---|`)
    const CAP = 40
    for (const i of resolved.slice(0, CAP)) {
      const info = issueInfo(i.code, i.detail)
      const ev = i.page && info.evidence ? info.evidence(i.page, i.detail) : i.detail
      L.push(`| ${mdCell(info.name)} | ${i.scope === 'site' ? 'পুরো সাইট' : mdCell(i.scope)} | ${mdCell(ev)} |`)
    }
    if (resolved.length > CAP) L.push(`| … | আরো ${resolved.length - CAP}টা | দুই audit.json মিলিয়ে যাচাইযোগ্য |`)
    L.push('')
  }

  if (introduced.length > 0) {
    L.push(`## ⚠️ নতুন সমস্যা (${introduced.length}টা)`, '', `| সমস্যা | কোথায় | বিস্তারিত |`, `|---|---|---|`)
    for (const i of introduced.slice(0, 25)) {
      const info = issueInfo(i.code, i.detail)
      L.push(`| ${mdCell(info.name)} | ${i.scope === 'site' ? 'পুরো সাইট' : mdCell(i.scope)} | ${mdCell(i.detail)} |`)
    }
    if (introduced.length > 25) L.push(`| … | আরো ${introduced.length - 25}টা | audit.json-এ |`)
    L.push('')
  }

  L.push(`## ⏳ এখনো বাকি (${remaining.length}টা)`, '')
  if (remaining.length === 0) L.push('- ✅ কিছু বাকি নেই!', '')
  else {
    const byName = new Map<string, number>()
    for (const i of remaining) {
      const n = `${SEV_BN[i.severity].split(' ')[0]} ${issueInfo(i.code, i.detail).name}`
      byName.set(n, (byName.get(n) ?? 0) + 1)
    }
    for (const [n, count] of [...byName.entries()].sort()) L.push(`- ${n} — ${count}টা জায়গায়`)
    L.push('')
  }

  L.push(
    `## প্রমাণ`,
    `- দুটো অডিটই একই পদ্ধতিতে (read-only ক্রল) চালানো — আগে ${before.pages?.length ?? 0} পেজ, পরে ${after.pages?.length ?? 0} পেজ পরীক্ষা।`,
    `- দুই অডিটের সম্পূর্ণ কাঁচা ডেটা (audit.json) সংরক্ষিত — প্রতিটি দাবির মান সেখানে মিলিয়ে দেখা যায়।`,
    '',
    `_ALMA Digital · আগে-পরে তুলনা রিপোর্ট · ${fmtDate(after.crawledAt)}_`,
  )
  return L.join('\n')
}
