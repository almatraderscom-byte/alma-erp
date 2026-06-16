/**
 * Semantic tool-group routing via cached embeddings.
 * Falls back silently to keyword-only when OPENAI_API_KEY is unavailable.
 */
import { embed } from '@/agent/lib/embeddings'
import type { ToolGroupName } from '@/agent/tools/tool-groups'

/**
 * Rich natural-language profiles for each tool group.
 * Include Banglish + Bengali + English keywords so embeddings
 * capture the semantic space of each group.
 */
const GROUP_PROFILES: Partial<Record<ToolGroupName, string>> = {
  staff:
    'staff management, হাজিরা attendance, টাস্ক task dispatch, propose tasks, ' +
    'Eyafi Mustahid employee, বেতন salary fine, approve dispatch, staff announcement, ' +
    'karmochari, lok, manush pathao, kaj dao, hajira check, dispatch koro',
  erp:
    'sales order inventory product stock, দাম price reorder catalog, ' +
    'get orders dashboard, বিক্রি bikri product details, ' +
    'order status customer summary, ajker sales koto, stock check, bikri report',
  finance:
    'expense ledger taka BDT AED money, খরচ হিসাব financial health, ' +
    'log expense income payment, টাকা khoroch, profit loss hisab, taka diya, ' +
    'koto taka laglo, maser khoroch, income report',
  cs:
    'customer service messenger winback segment inbox, ' +
    'customer intelligence, ক্রেতা গ্রাহক, CS response, ' +
    'kreta message, order help, customer reply, complaint handle',
  growth:
    'ads boost campaign ROAS SEO competitor marketing plan funnel, ' +
    'গ্রো মার্কেটিং ফানেল, advertising budget optimization scale, ' +
    'ad spend, competitor analysis, বিজ্ঞাপন boost, market research',
  content:
    'content image post creative reel video offer poster brand, ' +
    'ছবি ভিডিও রিল অফার পোস্টার ব্র্যান্ড, Facebook FB post, ' +
    'product shoot, photo edit, notun content banao, social media',
  website:
    'website almatraders publish catalog product page, ' +
    'ওয়েবসাইট catalog publish unpublish featured, ' +
    'site health check, product upload web',
  salah:
    'salah namaz prayer fajr dhuhr asr maghrib isha, ' +
    'নামাজ ফজর যোহর আসর মাগরিব ইশা জুম্মা, ' +
    'poreci porlam পড়েছি পড়লাম, prayer time namaz porlam ki',
  diag:
    'error bug diagnose health scan watchdog সমস্যা, ' +
    'system problem, API error, debug, somossa ki, ki hocche',
}

const MIN_SIMILARITY = 0.18
const EMBED_DIM = 1536

type CachedVectors = Map<ToolGroupName, number[]>

const globalForRouter = globalThis as unknown as {
  _semanticRouterVectors?: CachedVectors
  _semanticRouterLoading?: Promise<CachedVectors | null>
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

async function buildGroupVectors(): Promise<CachedVectors | null> {
  if (!process.env.OPENAI_API_KEY) return null

  const entries = Object.entries(GROUP_PROFILES) as [ToolGroupName, string][]
  const results = await Promise.all(
    entries.map(async ([group, profile]) => {
      const res = await embed(profile)
      if (!res.success) return null
      return [group, res.data] as [ToolGroupName, number[]]
    }),
  )

  const valid = results.filter((r): r is [ToolGroupName, number[]] => r !== null)
  if (valid.length === 0) return null
  return new Map(valid)
}

async function getGroupVectors(): Promise<CachedVectors | null> {
  if (globalForRouter._semanticRouterVectors) {
    return globalForRouter._semanticRouterVectors
  }
  if (globalForRouter._semanticRouterLoading) {
    return globalForRouter._semanticRouterLoading
  }

  globalForRouter._semanticRouterLoading = buildGroupVectors().then(v => {
    if (v) globalForRouter._semanticRouterVectors = v
    globalForRouter._semanticRouterLoading = undefined
    return v
  })

  return globalForRouter._semanticRouterLoading
}

/**
 * Returns top-K tool groups by semantic similarity to userText.
 * Returns empty array if embeddings are unavailable or no group exceeds threshold.
 */
export async function semanticGroups(
  userText: string,
  topK = 2,
): Promise<ToolGroupName[]> {
  const vectors = await getGroupVectors()
  if (!vectors) return []

  const queryResult = await embed(userText)
  if (!queryResult.success) return []

  const queryVec = queryResult.data
  if (queryVec.length !== EMBED_DIM) return []

  const scored: { group: ToolGroupName; sim: number }[] = []
  for (const [group, groupVec] of vectors) {
    const sim = cosine(queryVec, groupVec)
    if (sim >= MIN_SIMILARITY) {
      scored.push({ group, sim })
    }
  }

  scored.sort((a, b) => b.sim - a.sim)
  return scored.slice(0, topK).map(s => s.group)
}
