// Growth Autopilot — weekly analytics digest builder.
//
// Ingests three signals over the trailing 7 days and produces both a metrics
// snapshot (persisted for week-over-week history) and an owner-facing Bangla
// summary text:
//   1. Ads — aggregated spend / impressions / clicks / ROAS from active Meta campaigns.
//   2. Content cadence — posts published / upcoming / failed in the content calendar.
//   3. Catalog health — published vs draft products, missing-image count.
//
// Every source is wrapped so one failure degrades gracefully instead of
// aborting the whole digest. Nothing here publishes or spends — read-only.
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface AdsDigest {
  ok: boolean
  activeCampaigns: number
  /** Ad-account billing currency — spendWeekBdt is actually in THIS (field name is legacy). */
  currency: string
  spendWeekBdt: number
  impressionsWeek: number
  clicksWeek: number
  avgRoasWeek: number
  topCampaign: { name: string; spendWeek: number; roasWeek: number } | null
  error?: string
}

export interface ContentDigest {
  publishedLast7: number
  upcomingApproved: number
  drafts: number
  failedLast7: number
}

export interface CatalogDigest {
  ok: boolean
  totalPublished: number
  totalDraft: number
  noImageCount: number
  error?: string
}

export interface WeeklyDigest {
  periodStart: Date
  periodEnd: Date
  ads: AdsDigest
  content: ContentDigest
  catalog: CatalogDigest
  text: string
}

function bdt(n: number): string {
  return `৳${Math.round(n).toLocaleString('en-US')}`
}

async function buildAdsDigest(): Promise<AdsDigest> {
  try {
    // Weekly digest is HISTORICAL — must include campaigns paused mid-week
    // (live-found 2026-07-17: ACTIVE-only read reported ৳0 for a week with
    // real spend because the owner paused the campaign that morning).
    const { fetchCampaignMetricsWindow } = await import('@/agent/lib/ads/insights')
    const win = await fetchCampaignMetricsWindow(7)
    const rows = win.campaigns
    if (rows.length === 0) {
      return { ok: true, activeCampaigns: 0, currency: win.currency, spendWeekBdt: 0, impressionsWeek: 0, clicksWeek: 0, avgRoasWeek: 0, topCampaign: null }
    }
    const spendWeekBdt = rows.reduce((s, r) => s + r.spendWeek, 0)
    const impressionsWeek = rows.reduce((s, r) => s + r.impressionsWeek, 0)
    const clicksWeek = rows.reduce((s, r) => s + r.clicksWeek, 0)
    // Spend-weighted average ROAS (avoids tiny campaigns skewing the mean).
    const weightedRoas = spendWeekBdt > 0
      ? rows.reduce((s, r) => s + r.roasWeek * r.spendWeek, 0) / spendWeekBdt
      : 0
    const top = rows.slice().sort((a, b) => b.spendWeek - a.spendWeek)[0]
    return {
      ok: true,
      activeCampaigns: rows.length,
      currency: win.currency,
      spendWeekBdt,
      impressionsWeek,
      clicksWeek,
      avgRoasWeek: weightedRoas,
      topCampaign: top ? { name: top.name, spendWeek: top.spendWeek, roasWeek: top.roasWeek } : null,
    }
  } catch (err) {
    return {
      ok: false,
      activeCampaigns: 0,
      currency: 'USD',
      spendWeekBdt: 0,
      impressionsWeek: 0,
      clicksWeek: 0,
      avgRoasWeek: 0,
      topCampaign: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function buildContentDigest(since: Date): Promise<ContentDigest> {
  const [publishedLast7, upcomingApproved, drafts, failedLast7] = await Promise.all([
    db.agentContentCalendar.count({ where: { status: 'published', publishedAt: { gte: since } } }),
    db.agentContentCalendar.count({ where: { status: 'approved' } }),
    db.agentContentCalendar.count({ where: { status: 'draft' } }),
    db.agentContentCalendar.count({ where: { status: 'failed', createdAt: { gte: since } } }),
  ])
  return { publishedLast7, upcomingApproved, drafts, failedLast7 }
}

async function buildCatalogDigest(): Promise<CatalogDigest> {
  try {
    const { websiteCatalogStats } = await import('@/lib/website/catalog.service')
    const stats = await websiteCatalogStats()
    return {
      ok: true,
      totalPublished: stats.totalPublished,
      totalDraft: stats.totalDraft,
      noImageCount: stats.noImageCount,
    }
  } catch (err) {
    return { ok: false, totalPublished: 0, totalDraft: 0, noImageCount: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

function composeText(d: {
  periodStart: Date
  periodEnd: Date
  ads: AdsDigest
  content: ContentDigest
  catalog: CatalogDigest
}): string {
  const fmt = (dt: Date) =>
    dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }) // YYYY-MM-DD in Dhaka
  const lines: string[] = []
  lines.push(`📊 সাপ্তাহিক গ্রোথ রিপোর্ট (${fmt(d.periodStart)} → ${fmt(d.periodEnd)})`)
  lines.push('')

  // Ads
  if (!d.ads.ok) {
    lines.push('📣 বিজ্ঞাপন: ডেটা আনা যায়নি।')
  } else if (d.ads.activeCampaigns === 0) {
    lines.push('📣 বিজ্ঞাপন: এই সপ্তাহে কোনো active campaign ছিল না।')
  } else {
    lines.push(`📣 বিজ্ঞাপন (${d.ads.activeCampaigns}টি active):`)
    // Spend is in the AD ACCOUNT'S currency (USD here) — the old hardcoded ৳
    // label showed "৳11" where Ads Manager said $11.48 (live-hit 2026-07-17).
    const money = (n: number) => (d.ads.currency === 'BDT' ? bdt(n) : `${d.ads.currency} ${n.toFixed(2)}`)
    lines.push(`  • খরচ: ${money(d.ads.spendWeekBdt)} | ইমপ্রেশন: ${d.ads.impressionsWeek.toLocaleString('en-US')} | ক্লিক: ${d.ads.clicksWeek.toLocaleString('en-US')}`)
    lines.push(`  • গড় ROAS: ${d.ads.avgRoasWeek.toFixed(2)}x`)
    if (d.ads.topCampaign) {
      lines.push(`  • টপ: ${d.ads.topCampaign.name} — ${money(d.ads.topCampaign.spendWeek)}, ROAS ${d.ads.topCampaign.roasWeek.toFixed(2)}x`)
    }
  }
  lines.push('')

  // Content
  lines.push('📝 কনটেন্ট:')
  lines.push(`  • এই সপ্তাহে পাবলিশ: ${d.content.publishedLast7}টি`)
  lines.push(`  • অনুমোদিত ও শিডিউলড: ${d.content.upcomingApproved}টি | ড্রাফট: ${d.content.drafts}টি`)
  if (d.content.failedLast7 > 0) lines.push(`  • ⚠️ ব্যর্থ পোস্ট: ${d.content.failedLast7}টি`)
  lines.push('')

  // Catalog
  if (!d.catalog.ok) {
    lines.push('🛍️ ক্যাটালগ: ডেটা আনা যায়নি।')
  } else {
    lines.push('🛍️ ওয়েবসাইট ক্যাটালগ:')
    lines.push(`  • লাইভ: ${d.catalog.totalPublished}টি | ড্রাফট: ${d.catalog.totalDraft}টি`)
    if (d.catalog.noImageCount > 0) lines.push(`  • ⚠️ ছবিহীন প্রোডাক্ট: ${d.catalog.noImageCount}টি`)
  }

  return lines.join('\n')
}

/**
 * Build the weekly growth digest. Read-only; never throws for a single failed
 * source (each is degraded independently).
 */
export async function buildWeeklyDigest(now: Date = new Date()): Promise<WeeklyDigest> {
  const periodEnd = now
  const periodStart = new Date(now.getTime() - 7 * 86400000)

  const [ads, content, catalog] = await Promise.all([
    buildAdsDigest(),
    buildContentDigest(periodStart),
    buildCatalogDigest(),
  ])

  const text = composeText({ periodStart, periodEnd, ads, content, catalog })
  return { periodStart, periodEnd, ads, content, catalog, text }
}
