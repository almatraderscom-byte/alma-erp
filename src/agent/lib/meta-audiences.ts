/**
 * Meta Marketing API — Custom & Lookalike audiences (Phase: retargeting + lookalike).
 *
 * Read + create only. Every create here is a real side-effect on the live ad
 * account, so callers ALWAYS stage it behind an owner confirm card (the same
 * pattern as launch_campaign). Creating an audience never spends money — it only
 * defines who a future (PAUSED) campaign can target — but it is still owner-gated
 * because it writes to the account.
 *
 * Engagement Custom Audience = warm retargeting pool (people who already engaged
 * with the ALMA Facebook page / Messenger). Lookalike Audience = Meta finds NEW
 * people in Bangladesh similar to a warm source audience.
 */
import { resilientFetch } from '@/agent/lib/fetch-retry'
import { checkAdsManagementScope } from '@/agent/lib/meta-ads'
import { metaGraphBase } from '@/lib/meta-version'

const GRAPH_BASE = metaGraphBase()

function adsToken(): string {
  const tok = process.env.META_ADS_TOKEN
  if (!tok) throw new Error('META_ADS_TOKEN সেট করা নেই')
  return tok
}

/**
 * The ad account id as Meta expects it in a graph path, i.e. with the `act_`
 * prefix. META_AD_ACCOUNT_ID is already stored prefixed (launchCampaign uses it
 * raw as `${accountId}/campaigns`), so we pass it through and only add the prefix
 * defensively if the owner ever stores a bare numeric id.
 */
function adAccountPath(): string {
  const id = process.env.META_AD_ACCOUNT_ID
  if (!id) throw new Error('META_AD_ACCOUNT_ID সেট করা নেই')
  return /^act_/.test(id) ? id : `act_${id}`
}

// Known ALMA Facebook page IDs — mirror of the map in meta-ads.ts so an
// engagement audience can name its event source page the same way a launch does.
const PAGE_IDS: Record<string, string> = {
  lifestyle: '1044848232034171',
  onlineshop: '827260860637393',
}

export function resolveAudiencePageId(page?: string): string {
  const p = (page ?? 'lifestyle').toLowerCase()
  return PAGE_IDS[p] ?? (/^\d{6,}$/.test(p) ? p : PAGE_IDS.lifestyle)
}

export interface CustomAudienceSummary {
  id: string
  name: string
  subtype: string
  approxLower: number | null
  approxUpper: number | null
  operationStatus: string | null
  deliveryStatus: string | null
  timeCreated: string | null
}

/**
 * List the ad account's existing custom + lookalike audiences (newest first).
 * Read-only — safe to call without a confirm card. Sizes come back as Meta's
 * lower/upper approximate bounds (the exact `approximate_count` is deprecated).
 */
export async function listCustomAudiences(): Promise<{
  success: boolean
  audiences?: CustomAudienceSummary[]
  error?: string
}> {
  const scope = await checkAdsManagementScope()
  if (!scope.ok) return { success: false, error: scope.error }

  try {
    const params = new URLSearchParams({
      fields:
        'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status,time_created',
      limit: '50',
      access_token: adsToken(),
    })
    const res = await resilientFetch(`${GRAPH_BASE}/${adAccountPath()}/customaudiences?${params.toString()}`, {
      timeoutMs: 30_000,
      retries: 1,
    })
    const text = await res.text()
    if (!res.ok) return { success: false, error: `Audiences fetch ${res.status}: ${text.slice(0, 200)}` }
    const data = JSON.parse(text) as {
      data?: Array<{
        id: string
        name?: string
        subtype?: string
        approximate_count_lower_bound?: number
        approximate_count_upper_bound?: number
        operation_status?: { code?: number; description?: string }
        delivery_status?: { code?: number; description?: string }
        time_created?: string
      }>
    }
    const audiences: CustomAudienceSummary[] = (data.data ?? []).map((a) => ({
      id: a.id,
      name: a.name ?? '(unnamed)',
      subtype: a.subtype ?? 'UNKNOWN',
      approxLower: typeof a.approximate_count_lower_bound === 'number' ? a.approximate_count_lower_bound : null,
      approxUpper: typeof a.approximate_count_upper_bound === 'number' ? a.approximate_count_upper_bound : null,
      operationStatus: a.operation_status?.description ?? null,
      deliveryStatus: a.delivery_status?.description ?? null,
      timeCreated: a.time_created ?? null,
    }))
    return { success: true, audiences }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface EngagementAudienceSpec {
  name: string
  /** 'lifestyle' | 'onlineshop' | a raw numeric page id. Defaults lifestyle. */
  page?: string
  /**
   * How far back to include engagers, in days. Meta caps page-engagement
   * retention at 365 days. Defaults to the full 365 (widest warm pool).
   */
  retentionDays?: number
}

/**
 * Create an ENGAGEMENT custom audience of people who engaged with the ALMA
 * Facebook page (posts, ads, Messenger, profile visits, saves, CTA clicks).
 * This is the warm retargeting pool. Returns the new audience id.
 */
export async function createEngagementCustomAudience(
  spec: EngagementAudienceSpec,
): Promise<{ success: boolean; audienceId?: string; error?: string }> {
  const scope = await checkAdsManagementScope()
  if (!scope.ok) return { success: false, error: scope.error }

  const name = spec.name.trim()
  if (!name) return { success: false, error: 'audience name খালি' }
  const pageId = resolveAudiencePageId(spec.page)
  // Clamp retention to Meta's 1..365 day window for page engagement.
  const days = Math.min(365, Math.max(1, Math.round(spec.retentionDays ?? 365)))
  const retentionSeconds = days * 86_400

  const rule = {
    inclusions: {
      operator: 'or',
      rules: [
        {
          event_sources: [{ type: 'page', id: pageId }],
          retention_seconds: retentionSeconds,
          filter: {
            operators: 'or',
            filters: [{ field: 'event', operator: '=', value: 'page_engaged' }],
          },
        },
      ],
    },
  }

  try {
    const params = new URLSearchParams({
      name,
      subtype: 'ENGAGEMENT',
      rule: JSON.stringify(rule),
      access_token: adsToken(),
    })
    const res = await resilientFetch(`${GRAPH_BASE}/${adAccountPath()}/customaudiences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      timeoutMs: 45_000,
      retries: 1,
    })
    const text = await res.text()
    if (!res.ok) return { success: false, error: `Custom audience ${res.status}: ${text.slice(0, 240)}` }
    const data = JSON.parse(text) as { id?: string }
    if (!data.id) return { success: false, error: 'custom audience id ফেরত আসেনি' }
    return { success: true, audienceId: data.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface LookalikeAudienceSpec {
  name: string
  /** The source custom-audience id to model the lookalike on. */
  sourceAudienceId: string
  /** ISO country code for the lookalike population. Defaults BD (Bangladesh). */
  country?: string
  /**
   * Lookalike ratio 0.01..0.20 (1%..20% of the country population). Smaller =
   * tighter match to the source. Defaults 0.01 (the standard 1% LAL).
   */
  ratio?: number
}

/**
 * Create a LOOKALIKE audience from an existing source custom audience. Meta finds
 * new people in `country` that resemble the source. Source needs ~100+ matched
 * people or Meta rejects it — the error is surfaced verbatim to the owner.
 */
export async function createLookalikeAudience(
  spec: LookalikeAudienceSpec,
): Promise<{ success: boolean; audienceId?: string; error?: string }> {
  const scope = await checkAdsManagementScope()
  if (!scope.ok) return { success: false, error: scope.error }

  const name = spec.name.trim()
  if (!name) return { success: false, error: 'lookalike name খালি' }
  const sourceAudienceId = String(spec.sourceAudienceId ?? '').trim()
  if (!sourceAudienceId) return { success: false, error: 'sourceAudienceId দরকার' }
  const country = (spec.country ?? 'BD').toUpperCase()
  // Meta accepts ratios in 0.01 steps from 1% to 20%.
  const ratio = Math.min(0.2, Math.max(0.01, Number(spec.ratio ?? 0.01)))

  const lookalikeSpec = { type: 'similarity', country, ratio }

  try {
    const params = new URLSearchParams({
      name,
      subtype: 'LOOKALIKE',
      origin_audience_id: sourceAudienceId,
      lookalike_spec: JSON.stringify(lookalikeSpec),
      access_token: adsToken(),
    })
    const res = await resilientFetch(`${GRAPH_BASE}/${adAccountPath()}/customaudiences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      timeoutMs: 45_000,
      retries: 1,
    })
    const text = await res.text()
    if (!res.ok) return { success: false, error: `Lookalike ${res.status}: ${text.slice(0, 240)}` }
    const data = JSON.parse(text) as { id?: string }
    if (!data.id) return { success: false, error: 'lookalike audience id ফেরত আসেনি' }
    return { success: true, audienceId: data.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
