/**
 * Phase 47 — search-intent + topic-cluster strategy from real GSC data.
 * Pure functions over query rows; people-first content, no keyword stuffing,
 * no ranking promises.
 */

export type SearchIntent = 'informational' | 'navigational' | 'transactional' | 'commercial'

// \b does not bound Bangla words — use "no adjacent Bangla letter" instead.
const BN_RANGE = '[\\u0980-\\u09FF]'
const bn = (w: string) => `(?<!${BN_RANGE})(?:${w})(?!${BN_RANGE})`

const TRANSACTIONAL_RE = new RegExp(`\\b(price|buy|order|cash on delivery)\\b|${bn('দাম|কিনুন|অর্ডার|কেনা')}|কত\\s*টাকা`, 'i')
const COMMERCIAL_RE = new RegExp(`\\b(best|review|vs|compare)\\b|${bn('সেরা|রিভিউ|তুলনা')}|কোনটা ভালো`, 'i')
const NAVIGATIONAL_RE = new RegExp(`\\b(alma)\\b|${bn('আলমা|লগইন')}|facebook|website|login`, 'i')

/** Classify a query's dominant intent (Bangla + English patterns). */
export function classifyIntent(query: string): SearchIntent {
  const q = query.toLowerCase().trim()
  if (TRANSACTIONAL_RE.test(q)) return 'transactional'
  if (COMMERCIAL_RE.test(q)) return 'commercial'
  if (NAVIGATIONAL_RE.test(q)) return 'navigational'
  return 'informational'
}

export interface QueryRow {
  query: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface TopicCluster {
  pillar: string
  members: QueryRow[]
  totalClicks: number
  totalImpressions: number
  avgPosition: number
  dominantIntent: SearchIntent
  /** Position 5–20 with real impressions = the money zone for content work. */
  opportunity: boolean
}

const BN_STOP = new Set(['এর', 'কি', 'কী', 'কোথায', 'জনয', 'থেকে', 'and', 'the', 'for', 'in', 'of', 'to', 'a'])

function headTerm(query: string): string {
  const words = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !BN_STOP.has(w))
  return words[0] ?? query.toLowerCase()
}

/** Group queries into clusters by shared head term; rank by opportunity. */
export function buildTopicClusters(rows: QueryRow[], minImpressions = 10): TopicCluster[] {
  const groups = new Map<string, QueryRow[]>()
  for (const row of rows) {
    if (row.impressions < 1) continue
    const key = headTerm(row.query)
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }

  const clusters: TopicCluster[] = []
  for (const [pillar, members] of groups) {
    const totalClicks = members.reduce((s, m) => s + m.clicks, 0)
    const totalImpressions = members.reduce((s, m) => s + m.impressions, 0)
    if (totalImpressions < minImpressions) continue
    const avgPosition = members.reduce((s, m) => s + m.position * m.impressions, 0) / totalImpressions
    const intents = members.map((m) => classifyIntent(m.query))
    const dominantIntent = (['transactional', 'commercial', 'navigational', 'informational'] as const).find(
      (i) => intents.filter((x) => x === i).length >= members.length / 2,
    ) ?? 'informational'
    clusters.push({
      pillar,
      members: members.sort((a, b) => b.impressions - a.impressions),
      totalClicks,
      totalImpressions,
      avgPosition: Math.round(avgPosition * 10) / 10,
      dominantIntent,
      opportunity: avgPosition >= 5 && avgPosition <= 20 && totalImpressions >= minImpressions,
    })
  }
  return clusters.sort((a, b) => Number(b.opportunity) - Number(a.opportunity) || b.totalImpressions - a.totalImpressions)
}

export interface ContentGap {
  pillar: string
  reason: string
  intent: SearchIntent
  expectedImpact: string
  confidence: 'high' | 'medium' | 'low'
}

/**
 * Where demand exists (impressions) but no dedicated page does — candidates
 * for people-first content, each with honest expected impact.
 */
export function findContentGaps(clusters: TopicCluster[], existingPageSlugs: string[]): ContentGap[] {
  const slugs = existingPageSlugs.map((s) => s.toLowerCase())
  const gaps: ContentGap[] = []
  for (const c of clusters) {
    if (!c.opportunity) continue
    const covered = slugs.some((slug) => slug.includes(c.pillar))
    if (covered) continue
    gaps.push({
      pillar: c.pillar,
      reason: `${c.totalImpressions} impressions at avg position ${c.avgPosition} with no dedicated page`,
      intent: c.dominantIntent,
      expectedImpact:
        c.dominantIntent === 'transactional'
          ? 'direct order potential — product/category page'
          : 'assist/awareness traffic — guide or FAQ content; measure over 6–8 weeks, no ranking promise',
      confidence: c.totalImpressions > 100 ? 'high' : 'medium',
    })
  }
  return gaps
}
