/**
 * Meta Marketing API — read scope check + minimal write ops (Phase 10).
 */
import { resilientFetch } from '@/agent/lib/fetch-retry'

const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

function adsToken(): string {
  const tok = process.env.META_ADS_TOKEN
  if (!tok) throw new Error('META_ADS_TOKEN সেট করা নেই')
  return tok
}

export async function checkAdsManagementScope(): Promise<{ ok: boolean; scopes: string[]; error?: string }> {
  const token = process.env.META_ADS_TOKEN
  if (!token) {
    return { ok: false, scopes: [], error: 'META_ADS_TOKEN সেট করা নেই — Vercel/worker env-এ যোগ করুন।' }
  }

  try {
    const res = await resilientFetch(
      `${GRAPH_BASE}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
      { timeoutMs: 15_000, retries: 1 },
    )
    const data = (await res.json()) as { data?: { scopes?: string[]; is_valid?: boolean }; error?: { message?: string } }
    if (data.error) {
      return { ok: false, scopes: [], error: data.error.message ?? 'Token যাচাই ব্যর্থ' }
    }
    const scopes = data.data?.scopes ?? []
    if (!data.data?.is_valid) {
      return { ok: false, scopes, error: 'Meta Ads token অবৈধ বা মেয়াদ শেষ' }
    }
    if (!scopes.includes('ads_management')) {
      return {
        ok: false,
        scopes,
        error: 'ads_management scope নেই। Meta Developer Console → App → Permissions → ads_management যোগ করে token পুনর্জন্ম করুন।',
      }
    }
    return { ok: true, scopes }
  } catch (err) {
    return { ok: false, scopes: [], error: err instanceof Error ? err.message : String(err) }
  }
}

export async function pauseCampaign(campaignId: string): Promise<{ success: boolean; error?: string }> {
  const scope = await checkAdsManagementScope()
  if (!scope.ok) return { success: false, error: scope.error }

  const res = await resilientFetch(`${GRAPH_BASE}/${campaignId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PAUSED', access_token: adsToken() }),
    timeoutMs: 30_000,
    retries: 1,
  })
  if (!res.ok) {
    const err = await res.text()
    return { success: false, error: `Ads API ${res.status}: ${err.slice(0, 200)}` }
  }
  return { success: true }
}

export async function updateCampaignBudget(
  campaignId: string,
  dailyBudget: number,
): Promise<{ success: boolean; error?: string }> {
  const scope = await checkAdsManagementScope()
  if (!scope.ok) return { success: false, error: scope.error }

  // Meta expects budget in smallest currency unit (paisa for BDT)
  const budgetPaisa = Math.round(dailyBudget * 100)
  const res = await resilientFetch(`${GRAPH_BASE}/${campaignId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ daily_budget: budgetPaisa, access_token: adsToken() }),
    timeoutMs: 30_000,
    retries: 1,
  })
  if (!res.ok) {
    const err = await res.text()
    return { success: false, error: `Ads API ${res.status}: ${err.slice(0, 200)}` }
  }
  return { success: true }
}

export async function duplicateCampaign(
  campaignId: string,
  opts?: { statusOption?: 'PAUSED' | 'ACTIVE' },
): Promise<{ success: boolean; newCampaignId?: string; error?: string }> {
  const scope = await checkAdsManagementScope()
  if (!scope.ok) return { success: false, error: scope.error }

  const res = await resilientFetch(`${GRAPH_BASE}/${campaignId}/copies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deep_copy: false,
      status_option: opts?.statusOption ?? 'PAUSED',
      rename_options: {
        rename_strategy: 'DEEP_RENAME',
        rename_prefix: 'Copy — ',
      },
      access_token: adsToken(),
    }),
    timeoutMs: 45_000,
    retries: 1,
  })
  if (!res.ok) {
    const err = await res.text()
    return { success: false, error: `Ads API ${res.status}: ${err.slice(0, 200)}` }
  }
  const data = (await res.json()) as { copied_campaign_id?: string; id?: string }
  const newCampaignId = data.copied_campaign_id ?? data.id
  if (!newCampaignId) {
    return { success: false, error: 'Duplicate response missing new campaign id' }
  }
  return { success: true, newCampaignId }
}

// Known ALMA Facebook page IDs (same as src/agent/lib/meta.ts page map).
const PAGE_IDS: Record<string, string> = {
  lifestyle: '1044848232034171',
  onlineshop: '827260860637393',
}

function resolveAdPageId(page?: string): string {
  const p = (page ?? 'lifestyle').toLowerCase()
  return PAGE_IDS[p] ?? (/^\d{6,}$/.test(p) ? p : PAGE_IDS.lifestyle)
}

export interface LaunchCampaignSpec {
  name: string
  /** Whole BDT per day. Converted to paisa for Meta. */
  dailyBudgetBdt: number
  /** 'lifestyle' | 'onlineshop' | a raw numeric page id. Defaults lifestyle. */
  page?: string
  /** Primary ad text (Bangla). */
  message: string
  /** Optional short headline shown under the image. */
  headline?: string
  /** Public image URL for the creative (link_data.picture). Optional. */
  imageUrl?: string
  ageMin?: number
  ageMax?: number
}

/**
 * Launch a brand-new Messenger/CTWA (click-to-Messenger) campaign for ALMA's
 * COD funnel. Creates campaign → ad set → ad creative → ad, EVERY object in
 * PAUSED status so nothing can spend until the owner activates it in Ads
 * Manager. Built for the Advantage+ era: minimal targeting (Bangladesh + age),
 * Meta optimizes delivery. Returns the created object ids; on a mid-way failure
 * it returns whatever was created (all PAUSED, so harmless) plus the error.
 */
export async function launchCampaign(
  spec: LaunchCampaignSpec,
): Promise<{ success: boolean; campaignId?: string; adSetId?: string; adId?: string; error?: string }> {
  const scope = await checkAdsManagementScope()
  if (!scope.ok) return { success: false, error: scope.error }

  const accountId = process.env.META_AD_ACCOUNT_ID
  if (!accountId) return { success: false, error: 'META_AD_ACCOUNT_ID সেট করা নেই' }

  const token = adsToken()
  const pageId = resolveAdPageId(spec.page)
  const name = spec.name.trim() || 'ALMA নতুন ক্যাম্পেইন'
  const message = spec.message.trim()
  if (!message) return { success: false, error: 'Ad message (primary text) খালি' }
  const budgetPaisa = Math.round(Math.max(1, spec.dailyBudgetBdt) * 100)
  const ageMin = Math.min(65, Math.max(13, Math.round(spec.ageMin ?? 18)))
  const ageMax = Math.min(65, Math.max(ageMin, Math.round(spec.ageMax ?? 45)))

  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await resilientFetch(`${GRAPH_BASE}/${accountId}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, access_token: token }),
      timeoutMs: 45_000,
      retries: 1,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 240)}`)
    return JSON.parse(text) as { id?: string }
  }

  let campaignId: string | undefined
  let adSetId: string | undefined
  let adId: string | undefined
  try {
    const campaign = await post('campaigns', {
      name,
      objective: 'OUTCOME_ENGAGEMENT',
      status: 'PAUSED',
      special_ad_categories: [],
      // Budget lives at the ad-set level (daily_budget on the ad set below), not
      // campaign-level CBO. Newer Graph API versions REQUIRE this field to be
      // explicitly true/false on create — omitting it returns OAuthException
      // code 100 / subcode 4834011 ("Must specify True or False in
      // is_adset_budget_sharing_enabled field"). false = ad-set-level budgets.
      is_adset_budget_sharing_enabled: false,
    })
    campaignId = campaign.id
    if (!campaignId) throw new Error('campaign id ফেরত আসেনি')

    const adSet = await post('adsets', {
      name: `${name} — Ad Set`,
      campaign_id: campaignId,
      daily_budget: budgetPaisa,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'CONVERSATIONS',
      // With an ad-set-level daily_budget Meta REQUIRES an explicit bid_strategy;
      // omitting it makes Meta infer one that demands a bid cap, returning
      // OAuthException code 100 / subcode 2490487 ("Bid amount or bid constraints
      // required for bid strategy"). LOWEST_COST_WITHOUT_CAP = Highest-volume
      // auto-bidding, which needs NO bid amount — Meta optimizes delivery itself.
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      destination_type: 'MESSENGER',
      promoted_object: { page_id: pageId },
      targeting: { geo_locations: { countries: ['BD'] }, age_min: ageMin, age_max: ageMax },
      status: 'PAUSED',
    })
    adSetId = adSet.id
    if (!adSetId) throw new Error('ad set id ফেরত আসেনি')

    const creative = await post('adcreatives', {
      name: `${name} — Creative`,
      object_story_spec: {
        page_id: pageId,
        link_data: {
          message,
          name: spec.headline?.trim() || undefined,
          link: `https://m.me/${pageId}`,
          picture: spec.imageUrl?.trim() || undefined,
          call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } },
        },
      },
    })
    const creativeId = creative.id
    if (!creativeId) throw new Error('creative id ফেরত আসেনি')

    const ad = await post('ads', {
      name: `${name} — Ad`,
      adset_id: adSetId,
      creative: { creative_id: creativeId },
      status: 'PAUSED',
    })
    adId = ad.id
    return { success: true, campaignId, adSetId, adId }
  } catch (err) {
    return {
      success: false,
      campaignId,
      adSetId,
      adId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Duplicate top ad set within campaign (fresh ad set copy, PAUSED). */
export async function duplicateTopAdSet(
  campaignId: string,
): Promise<{ success: boolean; newAdSetId?: string; error?: string }> {
  const scope = await checkAdsManagementScope()
  if (!scope.ok) return { success: false, error: scope.error }

  const adSetsRes = await resilientFetch(
    `${GRAPH_BASE}/${campaignId}/adsets?` +
    new URLSearchParams({
      effective_status: '["ACTIVE"]',
      fields: 'id,name',
      limit: '10',
      access_token: adsToken(),
    }).toString(),
    { timeoutMs: 30_000, retries: 1 },
  )
  if (!adSetsRes.ok) {
    const err = await adSetsRes.text()
    return { success: false, error: `Ad sets fetch ${adSetsRes.status}: ${err.slice(0, 200)}` }
  }
  const adSets = (await adSetsRes.json()) as { data?: Array<{ id: string; name: string }> }
  const top = adSets.data?.[0]
  if (!top?.id) return { success: false, error: 'No active ad set found to duplicate' }

  const res = await resilientFetch(`${GRAPH_BASE}/${top.id}/copies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deep_copy: false,
      status_option: 'PAUSED',
      rename_options: { rename_strategy: 'DEEP_RENAME', rename_prefix: 'Copy — ' },
      access_token: adsToken(),
    }),
    timeoutMs: 45_000,
    retries: 1,
  })
  if (!res.ok) {
    const err = await res.text()
    return { success: false, error: `Ads API ${res.status}: ${err.slice(0, 200)}` }
  }
  const data = (await res.json()) as { copied_adset_id?: string; id?: string }
  const newAdSetId = data.copied_adset_id ?? data.id
  if (!newAdSetId) return { success: false, error: 'Duplicate response missing new ad set id' }
  return { success: true, newAdSetId }
}
