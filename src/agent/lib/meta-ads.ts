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
