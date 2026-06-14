/**
 * Oxylabs SERP + Web Scraper API client.
 * Docs: https://developers.oxylabs.io/
 * Credits are shared across SERP and Scraper products from one prepaid pool.
 */
import { logCost } from '@/agent/lib/cost-events'

const OXYLABS_ENDPOINT = 'https://realtime.oxylabs.io/v1/queries'

/** Each API call consumes 1 prepaid credit — logged as costUsd=1 for balance tracking. */
const CREDITS_PER_CALL = 1

function getAuth(): { username: string; password: string } | null {
  const username = (process.env.OXYLABS_USERNAME ?? '').trim()
  const password = (process.env.OXYLABS_PASSWORD ?? '').trim()
  if (!username || !password) return null
  return { username, password }
}

export function oxylabsConfigured(): boolean {
  return getAuth() !== null
}

export type OxylabsSerpResult = {
  url: string
  title: string
  desc?: string
  pos: number
}

function parseOrganicResults(data: unknown): OxylabsSerpResult[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (data as any)?.results?.[0]?.content
  const organic =
    content?.results?.organic
    ?? content?.organic
    ?? []
  if (!Array.isArray(organic)) return []
  return organic.map((r: { url?: string; title?: string; desc?: string; pos?: number }, idx: number) => ({
    url: String(r.url ?? ''),
    title: String(r.title ?? ''),
    desc: r.desc ? String(r.desc) : undefined,
    pos: Number(r.pos ?? idx + 1),
  }))
}

/**
 * Run a Google SERP query — returns top organic results.
 */
export async function oxylabsSerpSearch(query: string, opts: { limit?: number; geoLocation?: string } = {}): Promise<{
  success: boolean
  results?: OxylabsSerpResult[]
  raw?: unknown
  error?: string
}> {
  const auth = getAuth()
  if (!auth) return { success: false, error: 'Oxylabs not configured (OXYLABS_USERNAME/OXYLABS_PASSWORD).' }

  try {
    const res = await fetch(OXYLABS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
      },
      body: JSON.stringify({
        source: 'google_search',
        query,
        geo_location: opts.geoLocation ?? 'Bangladesh',
        parse: true,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text()
      return { success: false, error: `Oxylabs SERP HTTP ${res.status}: ${text.slice(0, 300)}` }
    }
    const data = await res.json()
    const limit = opts.limit ?? 10
    const results = parseOrganicResults(data).slice(0, limit)
    return { success: true, results, raw: data }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * Fetch + parse an arbitrary URL via Oxylabs Web Scraper (universal source).
 */
export async function oxylabsFetchPage(url: string, opts: { renderJs?: boolean } = {}): Promise<{
  success: boolean
  content?: string
  raw?: unknown
  error?: string
}> {
  const auth = getAuth()
  if (!auth) return { success: false, error: 'Oxylabs not configured (OXYLABS_USERNAME/OXYLABS_PASSWORD).' }

  try {
    const res = await fetch(OXYLABS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
      },
      body: JSON.stringify({
        source: 'universal',
        url,
        render: opts.renderJs ? 'html' : undefined,
        parse: false,
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) {
      const text = await res.text()
      return { success: false, error: `Oxylabs Scraper HTTP ${res.status}: ${text.slice(0, 300)}` }
    }
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html = (data as any)?.results?.[0]?.content ?? ''
    return { success: true, content: String(html), raw: data }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/** Log Oxylabs credit usage — costUsd tracks credits (1 per call), not dollars. */
export async function logOxylabsUsage(opts: {
  tool: string
  query: string
  success: boolean
  conversationId?: string | null
}): Promise<void> {
  try {
    void logCost({
      provider: 'oxylabs',
      kind: 'web_research',
      units: {
        tool: opts.tool,
        query: opts.query.slice(0, 200),
        success: opts.success ? 1 : 0,
        credits: CREDITS_PER_CALL,
      },
      costUsd: CREDITS_PER_CALL,
      conversationId: opts.conversationId ?? null,
    })
  } catch {
    // Logging failure must never break the research call itself
  }
}
