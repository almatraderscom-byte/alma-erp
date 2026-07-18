/**
 * Meta Ad Library search — BD fashion competitor creative intel.
 * Requires META_ADS_TOKEN with ads_read (Ad Library API access).
 */
import { resilientFetch } from '@/agent/lib/fetch-retry'
import { metaGraphBase } from '@/lib/meta-version'

const GRAPH_BASE = metaGraphBase()

export type AdLibraryAd = {
  id: string
  pageName?: string
  pageId?: string
  snapshotUrl?: string
  bodies?: string[]
  deliveryStart?: string
}

export type AdLibrarySearchResult = {
  ads: AdLibraryAd[]
  error?: string
  scopeGap?: boolean
}

function adsToken(): string | null {
  return process.env.META_ADS_TOKEN?.trim() || null
}

export async function searchAdsLibrary(opts: {
  searchTerms?: string
  brand?: string
  countries?: string[]
  limit?: number
}): Promise<AdLibrarySearchResult> {
  const token = adsToken()
  if (!token) {
    return { ads: [], error: 'META_ADS_TOKEN সেট করা নেই — Ad Library search চালানো যাবে না।', scopeGap: true }
  }

  const searchTerms = [opts.brand, opts.searchTerms].filter(Boolean).join(' ').trim()
  if (!searchTerms) {
    return { ads: [], error: 'keyword বা brand লাগবে' }
  }

  const countries = opts.countries?.length ? opts.countries : ['BD']
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 15)

  const params = new URLSearchParams({
    search_terms: searchTerms,
    ad_reached_countries: JSON.stringify(countries),
    ad_active_status: 'ACTIVE',
    ad_type: 'ALL',
    fields: [
      'id',
      'page_id',
      'page_name',
      'ad_snapshot_url',
      'ad_creative_bodies',
      'ad_delivery_start_time',
    ].join(','),
    limit: String(limit),
    access_token: token,
  })

  try {
    const res = await resilientFetch(`${GRAPH_BASE}/ads_archive?${params.toString()}`, {
      timeoutMs: 25_000,
      retries: 1,
    })
    const data = (await res.json()) as {
      data?: Array<{
        id: string
        page_id?: string
        page_name?: string
        ad_snapshot_url?: string
        ad_creative_bodies?: string[]
        ad_delivery_start_time?: string
      }>
      error?: { message?: string; code?: number; type?: string }
    }

    if (data.error) {
      const msg = data.error.message ?? 'Ad Library API error'
      const scopeGap =
        /permission|OAuth|ads_read|access token|authorized|Application does not have/i.test(msg)
      return { ads: [], error: msg, scopeGap }
    }

    const ads: AdLibraryAd[] = (data.data ?? []).map((row) => ({
      id: row.id,
      pageId: row.page_id,
      pageName: row.page_name,
      snapshotUrl: row.ad_snapshot_url,
      bodies: row.ad_creative_bodies,
      deliveryStart: row.ad_delivery_start_time,
    }))

    return { ads }
  } catch (err) {
    return { ads: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** Best-effort: pull a preview image URL from Ad Library snapshot HTML. */
export async function extractSnapshotImageUrl(snapshotUrl: string): Promise<string | null> {
  if (!snapshotUrl?.trim()) return null
  try {
    const res = await resilientFetch(snapshotUrl, {
      timeoutMs: 12_000,
      retries: 0,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ALMA-Agent/1.0)' },
    })
    if (!res.ok) return null
    const html = await res.text()
    const og = html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1]
    if (og) return og.replace(/&amp;/g, '&')
    const img = html.match(/https:\/\/[^"'\s]+(?:fbcdn|facebook)[^"'\s]+\.(?:jpg|jpeg|png|webp)/i)?.[0]
    return img ?? null
  } catch {
    return null
  }
}
