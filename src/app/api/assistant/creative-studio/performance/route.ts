import { timingSafeEqual } from 'node:crypto'
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { resilientFetch } from '@/agent/lib/fetch-retry'
import { resolvePageId } from '@/agent/lib/meta'
import {
  authenticateStudioRequest,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import { metaGraphBase } from '@/lib/meta-version'
import {
  getCreativePerformanceDashboard,
  PerformanceAttributionError,
  performanceAttributionErrorResponse,
  syncDueCreativePerformance,
  type MetaPerformanceFetcher,
} from '@/lib/creative-studio/performance-attribution'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

type GraphInsight = {
  name?: string
  values?: Array<{ value?: unknown; end_time?: string }>
}

function internalAuthorized(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN?.trim()
  const actual = req.headers.get('x-agent-internal-token')?.trim()
  if (!expected || !actual) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

function tokenForPage(pageId: string): string {
  if (pageId === '1044848232034171' && process.env.FB_PAGE_TOKEN_LIFESTYLE) {
    return process.env.FB_PAGE_TOKEN_LIFESTYLE
  }
  if (pageId === '827260860637393' && process.env.FB_PAGE_TOKEN_ONLINESHOP) {
    return process.env.FB_PAGE_TOKEN_ONLINESHOP
  }
  throw new Error(`meta_page_token_missing:${pageId}`)
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function insightValue(rows: GraphInsight[], name: string): number {
  const value = rows.find((row) => row.name === name)?.values?.[0]?.value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (sum, entry) => sum + number(entry),
      0,
    )
  }
  return number(value)
}

function actionValue(
  actions: Array<{ action_type?: string; value?: string | number }> | undefined,
  names: string[],
): number {
  return (actions ?? []).reduce((sum, action) => (
    action.action_type && names.includes(action.action_type)
      ? sum + number(action.value)
      : sum
  ), 0)
}

const fetchMetaMetrics: MetaPerformanceFetcher = async (delivery) => {
  const pageId = resolvePageId(delivery.pageRef)
  const token = tokenForPage(pageId)
  const base = metaGraphBase()
  if (delivery.adId) {
    const url = new URL(`${base}/${encodeURIComponent(delivery.adId)}/insights`)
    url.searchParams.set(
      'fields',
      'reach,impressions,clicks,spend,actions,date_start,date_stop,account_currency',
    )
    url.searchParams.set('date_preset', 'maximum')
    url.searchParams.set('access_token', token)
    const response = await resilientFetch(url.toString(), { timeoutMs: 20_000, retries: 1 })
    const body = await response.json().catch(() => ({})) as {
      data?: Array<Record<string, unknown>>
      error?: { message?: string; code?: number }
    }
    if (!response.ok) {
      throw new Error(`meta_ad_insights_${response.status}:${body.error?.code ?? 'unknown'}`)
    }
    const row = body.data?.[0] ?? {}
    const actions = Array.isArray(row.actions)
      ? row.actions as Array<{ action_type?: string; value?: string | number }>
      : []
    const dateStart = String(row.date_start ?? '')
    const dateStop = String(row.date_stop ?? '')
    return {
      externalObjectId: delivery.adId,
      reach: number(row.reach),
      impressions: number(row.impressions),
      engagements: actionValue(actions, ['post_engagement', 'page_engagement']),
      clicks: number(row.clicks),
      conversions: actionValue(actions, [
        'purchase',
        'offsite_conversion.fb_pixel_purchase',
        'omni_purchase',
      ]),
      spendAmount: row.spend == null ? null : number(row.spend),
      spendCurrency: typeof row.account_currency === 'string' ? row.account_currency : null,
      revenueBdt: null,
      sourceWindow: `${dateStart || 'all'}:${dateStop || new Date().toISOString().slice(0, 10)}`,
      raw: row,
    }
  }

  const graphId = delivery.platform === 'instagram'
    ? delivery.externalPostId
    : delivery.externalPostId.includes('_')
      ? delivery.externalPostId
      : `${pageId}_${delivery.externalPostId}`
  const url = new URL(`${base}/${encodeURIComponent(graphId)}/insights`)
  url.searchParams.set(
    'metric',
    delivery.platform === 'instagram'
      ? 'reach,impressions,engagement,saved'
      : 'post_impressions,post_impressions_unique,post_engaged_users,post_clicks',
  )
  url.searchParams.set('access_token', token)
  const response = await resilientFetch(url.toString(), { timeoutMs: 20_000, retries: 1 })
  const body = await response.json().catch(() => ({})) as {
    data?: GraphInsight[]
    error?: { message?: string; code?: number }
  }
  if (!response.ok) {
    throw new Error(`meta_post_insights_${response.status}:${body.error?.code ?? 'unknown'}`)
  }
  const rows = body.data ?? []
  const sourceWindow = rows
    .flatMap((row) => row.values?.map((value) => value.end_time).filter(Boolean) ?? [])
    .sort()
    .at(-1) ?? new Date().toISOString().slice(0, 10)
  return {
    externalObjectId: graphId,
    reach: insightValue(rows, delivery.platform === 'instagram' ? 'reach' : 'post_impressions_unique'),
    impressions: insightValue(rows, delivery.platform === 'instagram' ? 'impressions' : 'post_impressions'),
    engagements: insightValue(rows, delivery.platform === 'instagram' ? 'engagement' : 'post_engaged_users'),
    clicks: insightValue(rows, delivery.platform === 'instagram' ? 'saved' : 'post_clicks'),
    conversions: 0,
    spendAmount: null,
    spendCurrency: null,
    revenueBdt: null,
    sourceWindow,
    raw: { data: rows },
  }
}

function routeError(error: unknown): Response {
  if (error instanceof PerformanceAttributionError) {
    return performanceAttributionErrorResponse(error, 'creative-performance')
  }
  return studioAccessErrorResponse(error, 'creative-performance')
}

export async function GET(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  try {
    return Response.json(await getCreativePerformanceDashboard(actor, {
      brandProfileId: req.nextUrl.searchParams.get('brandProfileId') ?? '',
      projectId: req.nextUrl.searchParams.get('projectId'),
      assetId: req.nextUrl.searchParams.get('assetId'),
    }))
  } catch (error) {
    return routeError(error)
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!internalAuthorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (body.intent !== 'sync_due') {
    return Response.json({ error: 'invalid_performance_intent' }, { status: 422 })
  }
  try {
    return Response.json(await syncDueCreativePerformance({
      fetchMetrics: fetchMetaMetrics,
      limit: body.limit == null ? undefined : Number(body.limit),
    }))
  } catch (error) {
    return routeError(error)
  }
}
