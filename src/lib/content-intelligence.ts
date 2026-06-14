/**
 * Marketing & content intelligence — learned patterns, stale products, seasonal hooks.
 */
import { prisma } from '@/lib/prisma'
import { recallFacts, searchFactsByName, formatFactLine } from '@/lib/knowledge-graph'
import { upcomingSeasons, seasonDateSettingKey, type UpcomingSeason } from '@/lib/marketing-calendar'
import { getProductUnitsSold } from '@/lib/outcome-metrics'
import { trackOutcome } from '@/lib/outcome-loop'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const CONTENT_TYPE_LABELS: Record<string, string> = {
  video_reel: 'রিল/ভিডিও',
  product_content: 'প্রোডাক্ট ছবি+ক্যাপশন',
  ad_creative: 'অ্যাড ক্রিয়েটিভ',
  fb_photo: 'Facebook ফটো পোস্ট',
  fb_text: 'Facebook টেক্সট পোস্ট',
  product_photo: 'প্রোডাক্ট ফটো',
  organic_marketing: 'ওয়েবসাইট/অর্গানিক মার্কেটিং',
  offer_idea: 'অফার আইডিয়া',
}

export type StaleProduct = {
  productRef: string
  business: string
  lastPromotedAt: string
  daysSincePromo: number
}

export type ContentApproach = {
  approach: string
  reason: string
  confidence: number | null
  source: 'learned' | 'seasonal' | 'default'
}

export type ContentRecommendation = {
  category: string
  approach: string
  reason: string
  seasonalHook: string | null
  learnedFacts: string[]
}

export type MarketingIntel = {
  upcomingSeasons: UpcomingSeason[]
  staleProducts: StaleProduct[]
  bestApproaches: ContentApproach[]
  recommendations: ContentRecommendation[]
  notes: string[]
}

export async function getStaleProducts(notSinceDays = 30, limit = 10): Promise<StaleProduct[]> {
  const cutoff = new Date(Date.now() - notSinceDays * 86_400_000)
  const rows = await db.agentProductMarketingHistory.findMany({
    where: { lastPromotedAt: { lt: cutoff } },
    orderBy: { lastPromotedAt: 'asc' },
    take: limit,
    select: { productRef: true, business: true, lastPromotedAt: true },
  }) as Array<{ productRef: string; business: string; lastPromotedAt: Date }>

  return rows.map((r) => ({
    productRef: r.productRef,
    business: r.business,
    lastPromotedAt: r.lastPromotedAt.toISOString(),
    daysSincePromo: Math.floor((Date.now() - r.lastPromotedAt.getTime()) / 86_400_000),
  }))
}

function categoryMatches(text: string, category: string): boolean {
  const t = text.toLowerCase()
  const c = category.toLowerCase()
  if (t.includes(c)) return true
  const aliases: Record<string, string[]> = {
    punjabi: ['panjabi', 'পাঞ্জাবি', 'punjabi'],
    panjabi: ['panjabi', 'পাঞ্জাবি', 'punjabi'],
    saree: ['saree', 'শাড়ি', 'sari'],
    traditional: ['traditional', 'ট্র্যাডিশনাল'],
    winter: ['winter', 'শীত', 'shawl', 'hoodie'],
  }
  return (aliases[c] ?? [c]).some((a) => t.includes(a))
}

async function gatherBestApproaches(category?: string): Promise<ContentApproach[]> {
  const facts = await recallFacts('product')
  const contentFacts = facts.filter((f) => f.attribute === 'best_content_type')

  const approaches: ContentApproach[] = []
  for (const f of contentFacts) {
    const name = f.entityName ?? f.entityId ?? ''
    if (category && name && !categoryMatches(name, category) && !categoryMatches(f.value, category)) {
      continue
    }
    approaches.push({
      approach: f.value,
      reason: `${name || 'প্রোডাক্ট'} — outcome tracking থেকে শিখা (সংযুক্তি, causation নয়)`,
      confidence: Math.round(f.confidence * 100) / 100,
      source: 'learned',
    })
  }

  return approaches.slice(0, 5)
}

function seasonalHookForCategory(seasons: UpcomingSeason[], category: string): string | null {
  const match = seasons.find((s) => s.categories.some((c) => categoryMatches(category, c)))
  if (!match) return null
  const dateNote =
    match.dateSource === 'owner' && match.exactDate
      ? `${match.exactDate} (owner-set)`
      : 'আনুমানিক তারিখ — owner exact date set করলে নির্ভুল হবে'
  return `${match.name} ${match.weeksUntil ?? '?'} সপ্তাহ দূরে — ${match.note} (${dateNote})`
}

/** Suggest the best content approach for a product/category from learned facts + season. */
export async function contentRecommendation(category: string): Promise<ContentRecommendation> {
  const cat = category.trim() || 'general'
  const [seasons, approaches] = await Promise.all([
    upcomingSeasons(),
    gatherBestApproaches(cat),
  ])

  const learnedFacts = approaches.map((a) => a.approach)
  const seasonalHook = seasonalHookForCategory(seasons, cat)

  if (approaches.length) {
    const top = approaches[0]!
    return {
      category: cat,
      approach: top.approach,
      reason: top.reason,
      seasonalHook,
      learnedFacts,
    }
  }

  const facts = await searchFactsByName('product', cat)
  const sellFact = facts.find((f) => f.attribute === 'avg_weekly_sales' || f.attribute === 'sell_trend')
  const defaultApproach =
    categoryMatches(cat, 'punjabi') || categoryMatches(cat, 'panjabi')
      ? 'রিল/ভিডিও + ফ্যামিলি সেট — ঈদ/উৎসবে ভালো চলে (এখনো outcome data কম)'
      : categoryMatches(cat, 'saree')
        ? 'মডেল ফটো + স্টোরি — পূজা/বৈশাখে demand (outcome data জমা হচ্ছে)'
        : 'প্রোডাক্ট ফটো + ক্যাপশন — ALMA warm/family-oriented ভয়েস'

  return {
    category: cat,
    approach: defaultApproach,
    reason: sellFact
      ? `${formatFactLine(sellFact)} — এখনো best_content_type শেখা হয়নি`
      : 'Learned content pattern এখনো নেই — generic ALMA voice',
    seasonalHook,
    learnedFacts: facts.slice(0, 3).map(formatFactLine),
  }
}

export async function buildMarketingIntel(category?: string): Promise<MarketingIntel> {
  const [seasons, staleProducts, bestApproaches] = await Promise.all([
    upcomingSeasons(),
    getStaleProducts(30, 8),
    gatherBestApproaches(category),
  ])

  const recommendations: ContentRecommendation[] = []
  const cats = category
    ? [category]
    : [...new Set(seasons.flatMap((s) => s.categories))].slice(0, 4)

  for (const cat of cats) {
    recommendations.push(await contentRecommendation(cat))
  }

  const notes: string[] = []
  const lunar = seasons.filter((s) => s.key.startsWith('eid') || s.key === 'puja')
  for (const s of lunar) {
    if (s.dateSource !== 'owner') {
      notes.push(
        `${s.name}: তারিখ আনুমানিক — exact date এর জন্য settings-এ ${seasonDateSettingKey(s.key)} সেট করুন।`,
      )
    }
  }
  if (!bestApproaches.length) {
    notes.push('Content outcome data এখনো কম — পোস্ট/track হলে best_content_type শেখা শুরু হবে।')
  }

  return {
    upcomingSeasons: seasons,
    staleProducts,
    bestApproaches,
    recommendations,
    notes,
  }
}

export function extractProductRef(text: string): string | null {
  const m = text.match(/\b(FM[-\w\d]+|AL[-\w\d]+)\b/i)
  return m ? m[1]!.toUpperCase() : null
}

export async function recordProductPromotion(
  productRef: string,
  contentType: string,
  business = 'ALMA Lifestyle',
): Promise<void> {
  if (!productRef?.trim()) return
  try {
    await db.agentProductMarketingHistory.create({
      data: {
        productRef: productRef.trim(),
        business,
        contentType,
        lastPromotedAt: new Date(),
      },
    })
  } catch (e) {
    console.warn('[content-intel] record promotion failed', e)
  }
}

export async function trackPublishedContent(args: {
  productRef?: string | null
  message: string
  contentType: string
  page?: string
}): Promise<void> {
  const productRef = args.productRef?.trim() || extractProductRef(args.message)
  if (!productRef) return

  const sales14d = await getProductUnitsSold(productRef, 14).catch(() => null)
  const typeLabel = CONTENT_TYPE_LABELS[args.contentType] ?? args.contentType

  await trackOutcome({
    type: 'content',
    subjectKind: 'product',
    subjectId: productRef,
    subjectName: productRef,
    suggestion: `${typeLabel} পোস্ট — ${args.message.slice(0, 120)}`,
    rationale: `Published content: ${args.contentType}${args.page ? ` on ${args.page}` : ''}`,
    metric: 'units_sold_14d',
    baselineValue: sales14d ?? undefined,
    predicted: 'কন্টেন্টের পর ১৪ দিনে বিক্রি বাড়তে পারে (সংযুক্তি)',
    measureAfterDays: 14,
  })

  await recordProductPromotion(productRef, args.contentType)
}
