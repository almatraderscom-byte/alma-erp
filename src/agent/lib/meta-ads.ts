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
  /**
   * Public image URL for the creative. REQUIRED for Click-to-Messenger ads —
   * the bytes are uploaded to the ad account's image library and referenced by
   * image_hash (a raw picture URL is unreliable for signed/query-string URLs).
   */
  imageUrl?: string
  ageMin?: number
  ageMax?: number
  /**
   * Optional custom/lookalike audience id to TARGET (retargeting or lookalike
   * campaign). When set, the ad set targets exactly this audience (Advantage
   * audience expansion stays off) instead of broad Bangladesh prospecting.
   */
  audienceId?: string
  /** Optional custom audience id to EXCLUDE (e.g. exclude existing engagers from a lookalike prospecting campaign). */
  excludeAudienceId?: string
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
  // A Click-to-Messenger link ad REQUIRES media. Without it the ads-create step
  // 400s with subcode 1487212 ("Missing media"). Reject early with a clear Bangla
  // message so the agent never stages an imageless launch that is doomed to fail.
  const imageUrl = spec.imageUrl?.trim()
  if (!imageUrl) {
    return { success: false, error: 'ছবি ছাড়া Click-to-Messenger ক্যাম্পেইন চালু করা যায় না — একটি প্রোডাক্ট ছবির public URL দিন।' }
  }
  const budgetPaisa = Math.round(Math.max(1, spec.dailyBudgetBdt) * 100)
  const ageMin = Math.min(65, Math.max(13, Math.round(spec.ageMin ?? 18)))
  const ageMax = Math.min(65, Math.max(ageMin, Math.round(spec.ageMax ?? 45)))
  const audienceId = spec.audienceId?.trim()
  const excludeAudienceId = spec.excludeAudienceId?.trim()

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

  // Upload the creative image to the ad account's image library and return its
  // image_hash. Meta's link_data.picture (a raw URL) is unreliable for long
  // signed URLs — it 400s with OAuthException 100 ("Invalid parameter" on
  // img_url) because Meta's crawler can't ingest the query-string token. The
  // robust path is image_hash: we fetch the bytes server-side (where the signed
  // Supabase URL is reachable) and hand Meta the binary directly.
  const uploadImageHash = async (url: string): Promise<string> => {
    const imgRes = await resilientFetch(url, { timeoutMs: 30_000, retries: 1 })
    if (!imgRes.ok) throw new Error(`creative image fetch ব্যর্থ: HTTP ${imgRes.status}`)
    const b64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64')
    const params = new URLSearchParams({ bytes: b64, access_token: token })
    const res = await resilientFetch(`${GRAPH_BASE}/${accountId}/adimages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      timeoutMs: 60_000,
      retries: 1,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`adimages ${res.status}: ${text.slice(0, 240)}`)
    const data = JSON.parse(text) as { images?: Record<string, { hash?: string }> }
    const hash = data.images ? Object.values(data.images)[0]?.hash : undefined
    if (!hash) throw new Error('adimages থেকে image_hash ফেরত আসেনি')
    return hash
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
      targeting: {
        geo_locations: { countries: ['BD'] },
        age_min: ageMin,
        age_max: ageMax,
        // Retargeting / lookalike: when an audience id is supplied the ad set
        // targets exactly that custom or lookalike audience. excluded_custom_audiences
        // lets a lookalike prospecting campaign exclude existing warm engagers so
        // it only reaches NEW similar people.
        ...(audienceId ? { custom_audiences: [{ id: audienceId }] } : {}),
        ...(excludeAudienceId ? { excluded_custom_audiences: [{ id: excludeAudienceId }] } : {}),
        // Advantage+ era: Meta REQUIRES an explicit Advantage Audience flag or the
        // create 400s with OAuthException 100 / subcode 1870227 ("Advantage
        // audience flag required"). 0 = OFF, so Meta honors exactly the targeting
        // we specified (Bangladesh + the age range, plus any custom audience)
        // instead of expanding beyond it.
        targeting_automation: { advantage_audience: 0 },
      },
      status: 'PAUSED',
    })
    adSetId = adSet.id
    if (!adSetId) throw new Error('ad set id ফেরত আসেনি')

    const imageHash = await uploadImageHash(imageUrl)
    const creative = await post('adcreatives', {
      name: `${name} — Creative`,
      object_story_spec: {
        page_id: pageId,
        link_data: {
          message,
          name: spec.headline?.trim() || undefined,
          link: `https://m.me/${pageId}`,
          image_hash: imageHash,
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
