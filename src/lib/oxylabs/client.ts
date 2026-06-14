/**
 * Oxylabs client — supports Hostinger AI Studio API key (primary) and
 * legacy Web Scraper username/password (optional fallback).
 *
 * Hostinger VPS free credits use AI Studio: https://api-aistudio.oxylabs.io
 * with header `x-api-key` (copy from Docker Manager → Oxylabs → Key).
 */
import { logCost } from '@/agent/lib/cost-events'

const AI_STUDIO_BASE = 'https://api-aistudio.oxylabs.io'
const LEGACY_ENDPOINT = 'https://realtime.oxylabs.io/v1/queries'

/** Each API call consumes 1 prepaid credit — logged as costUsd=1 for balance tracking. */
const CREDITS_PER_CALL = 1

type AuthMode = 'api_key' | 'basic' | null

function resolveAuth(): { mode: AuthMode; apiKey?: string; username?: string; password?: string } {
  const apiKey = (process.env.OXYLABS_API_KEY ?? process.env.OXYLABS_AISTUDIO_API_KEY ?? '').trim()
  if (apiKey) return { mode: 'api_key', apiKey }

  const username = (process.env.OXYLABS_USERNAME ?? '').trim()
  const password = (process.env.OXYLABS_PASSWORD ?? '').trim()
  if (username && password) return { mode: 'basic', username, password }

  return { mode: null }
}

export function oxylabsConfigured(): boolean {
  return resolveAuth().mode !== null
}

export type OxylabsSerpResult = {
  url: string
  title: string
  desc?: string
  pos: number
}

function parseLegacyOrganic(data: unknown): OxylabsSerpResult[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (data as any)?.results?.[0]?.content
  const organic = content?.results?.organic ?? content?.organic ?? []
  if (!Array.isArray(organic)) return []
  return organic.map((r: { url?: string; title?: string; desc?: string; pos?: number }, idx: number) => ({
    url: String(r.url ?? ''),
    title: String(r.title ?? ''),
    desc: r.desc ? String(r.desc) : undefined,
    pos: Number(r.pos ?? idx + 1),
  }))
}

function parseAiStudioSearch(data: unknown): OxylabsSerpResult[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data as any)?.data ?? []
  if (!Array.isArray(rows)) return []
  return rows.map((r: { url?: string; title?: string; description?: string }, idx: number) => ({
    url: String(r.url ?? ''),
    title: String(r.title ?? ''),
    desc: r.description ? String(r.description) : undefined,
    pos: idx + 1,
  }))
}

async function aiStudioSearch(
  apiKey: string,
  query: string,
  opts: { limit?: number; geoLocation?: string },
): Promise<{ success: boolean; results?: OxylabsSerpResult[]; raw?: unknown; error?: string }> {
  const body: Record<string, unknown> = {
    query,
    limit: opts.limit ?? 10,
  }
  if (opts.geoLocation) body.geo_location = opts.geoLocation

  const res = await fetch(`${AI_STUDIO_BASE}/search/instant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text()
    return { success: false, error: `Oxylabs AI Studio search HTTP ${res.status}: ${text.slice(0, 300)}` }
  }
  const data = await res.json()
  return { success: true, results: parseAiStudioSearch(data), raw: data }
}

async function legacySerpSearch(
  username: string,
  password: string,
  query: string,
  opts: { limit?: number; geoLocation?: string },
): Promise<{ success: boolean; results?: OxylabsSerpResult[]; raw?: unknown; error?: string }> {
  const res = await fetch(LEGACY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
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
  return { success: true, results: parseLegacyOrganic(data).slice(0, limit), raw: data }
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
  const auth = resolveAuth()
  if (!auth.mode) {
    return { success: false, error: 'Oxylabs not configured (set OXYLABS_API_KEY from Hostinger Docker Manager, or OXYLABS_USERNAME/OXYLABS_PASSWORD).' }
  }

  try {
    const limit = Math.min(opts.limit ?? 10, auth.mode === 'api_key' ? 10 : 10)
    const geo = opts.geoLocation ?? 'Bangladesh'
    if (auth.mode === 'api_key' && auth.apiKey) {
      return await aiStudioSearch(auth.apiKey, query, { limit, geoLocation: geo })
    }
    if (auth.mode === 'basic' && auth.username && auth.password) {
      return await legacySerpSearch(auth.username, auth.password, query, { limit, geoLocation: geo })
    }
    return { success: false, error: 'Oxylabs auth misconfigured.' }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function aiStudioFetchPage(apiKey: string, url: string): Promise<{
  success: boolean
  content?: string
  raw?: unknown
  error?: string
}> {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
  }

  const createRes = await fetch(`${AI_STUDIO_BASE}/scrape`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!createRes.ok) {
    const text = await createRes.text()
    return { success: false, error: `Oxylabs scrape create HTTP ${createRes.status}: ${text.slice(0, 300)}` }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createData = await createRes.json() as any
  const runId = String(createData?.run_id ?? '')
  if (!runId) return { success: false, error: 'Oxylabs scrape create returned no run_id' }

  const maxPolls = 8
  const pollIntervalMs = 3000
  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(pollIntervalMs)
    const pollRes = await fetch(
      `${AI_STUDIO_BASE}/scrape/run/data?run_id=${encodeURIComponent(runId)}`,
      { method: 'GET', headers, signal: AbortSignal.timeout(15_000) },
    )
    if (!pollRes.ok) continue

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pollData = await pollRes.json() as any
    const status = String(pollData?.status ?? '').toLowerCase()
    if (status === 'failed' || status === 'error') {
      return { success: false, error: 'Oxylabs scrape run failed' }
    }
    if (status === 'completed' || status === 'done') {
      const data = pollData?.data
      const content = typeof data === 'string' ? data : JSON.stringify(data ?? '', null, 2)
      return { success: true, content, raw: pollData }
    }
  }

  return { success: false, error: `Oxylabs scrape timed out after ${maxPolls} polls` }
}

async function legacyFetchPage(username: string, password: string, url: string): Promise<{
  success: boolean
  content?: string
  raw?: unknown
  error?: string
}> {
  const res = await fetch(LEGACY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    },
    body: JSON.stringify({
      source: 'universal',
      url,
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
}

/**
 * Fetch + parse an arbitrary URL (competitor page, etc.).
 */
export async function oxylabsFetchPage(url: string, opts: { renderJs?: boolean } = {}): Promise<{
  success: boolean
  content?: string
  raw?: unknown
  error?: string
}> {
  const auth = resolveAuth()
  if (!auth.mode) {
    return { success: false, error: 'Oxylabs not configured (set OXYLABS_API_KEY from Hostinger Docker Manager, or OXYLABS_USERNAME/OXYLABS_PASSWORD).' }
  }

  try {
    if (auth.mode === 'api_key' && auth.apiKey) {
      return await aiStudioFetchPage(auth.apiKey, url)
    }
    if (auth.mode === 'basic' && auth.username && auth.password) {
      void opts.renderJs
      return await legacyFetchPage(auth.username, auth.password, url)
    }
    return { success: false, error: 'Oxylabs auth misconfigured.' }
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
