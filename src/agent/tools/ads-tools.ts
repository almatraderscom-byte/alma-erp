/**
 * Phase 10 + File 11 — Ads write + closed-loop optimizer recommendations.
 */
import { prisma } from '@/lib/prisma'
import { checkAdsManagementScope } from '@/agent/lib/meta-ads'
import { listCustomAudiences } from '@/agent/lib/meta-audiences'
import {
  analyzeAdCampaigns,
  createAdsOptimizerBatchCard,
  formatRecommendationsSummary,
  recordRecommendationOutcomes,
} from '@/agent/lib/ads/optimizer'
import {
  buildCampaignDiff,
  campaignIdempotencyKey,
  validateCampaignSpec,
  SUPPORTED_OBJECTIVES,
  KNOWN_UNSUPPORTED_OBJECTIVES,
  type CampaignPlanSpec,
} from '@/agent/lib/marketing/meta-campaign-graph'
import { getApprovedBrief } from '@/agent/lib/marketing/growth-brief'
import { capiHealth } from '@/agent/lib/marketing/meta-capi'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const pause_campaign: AgentTool = {
  name: 'pause_campaign',
  description:
    'Pauses a Meta Ads campaign by ID. ALWAYS creates a confirm card — owner must approve. Requires ads_management token scope.',
  input_schema: {
    type: 'object' as const,
    properties: {
      campaignId: { type: 'string', description: 'Meta campaign ID' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['campaignId'],
  },
  handler: async (input) => {
    const campaignId = String(input.campaignId ?? '').trim()
    if (!campaignId) return { success: false, error: 'campaignId is required' }

    const scope = await checkAdsManagementScope()
    if (!scope.ok) return { success: false, error: scope.error }

    const summary = `Meta Ads ক্যাম্পেইন পজ করুন?\nCampaign ID: ${campaignId}\n\nApprove করলে status → PAUSED হবে।`

    const action = await db.agentPendingAction.create({
      data: {
        conversationId: input.conversationId ? String(input.conversationId) : null,
        type: 'pause_campaign',
        payload: { campaignId },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })

    return {
      success: true,
      data: { pendingActionId: action.id as string, summary, message: 'Pending owner confirmation.' },
    }
  },
}

const update_campaign_budget: AgentTool = {
  name: 'update_campaign_budget',
  description:
    'Updates daily budget for a Meta Ads campaign. ALWAYS creates a confirm card. Requires ads_management token scope. Amount in whole BDT.',
  input_schema: {
    type: 'object' as const,
    properties: {
      campaignId: { type: 'string', description: 'Meta Ads campaign id' },
      dailyBudget: { type: 'number', description: 'New daily budget in whole BDT' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['campaignId', 'dailyBudget'],
  },
  handler: async (input) => {
    const campaignId = String(input.campaignId ?? '').trim()
    const dailyBudget = Math.round(Number(input.dailyBudget))
    if (!campaignId) return { success: false, error: 'campaignId is required' }
    if (dailyBudget <= 0) return { success: false, error: 'dailyBudget must be positive' }

    const scope = await checkAdsManagementScope()
    if (!scope.ok) return { success: false, error: scope.error }

    const summary =
      `Meta Ads দৈনিক বাজেট আপডেট?\nCampaign ID: ${campaignId}\nনতুন বাজেট: ৳${dailyBudget.toLocaleString('bn-BD')}/দিন`

    const action = await db.agentPendingAction.create({
      data: {
        conversationId: input.conversationId ? String(input.conversationId) : null,
        type: 'update_campaign_budget',
        payload: { campaignId, dailyBudget },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })

    return {
      success: true,
      data: { pendingActionId: action.id as string, summary, message: 'Pending owner confirmation.' },
    }
  },
}

const duplicate_campaign: AgentTool = {
  name: 'duplicate_campaign',
  description:
    'Duplicates a winning Meta Ads campaign as a PAUSED copy (fresh ad set via Meta copy API). ' +
    'ALWAYS creates a confirm card — owner must approve. Use for scaling winners without over-editing the original.',
  input_schema: {
    type: 'object' as const,
    properties: {
      campaignId: { type: 'string', description: 'Source Meta campaign ID to duplicate' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['campaignId'],
  },
  handler: async (input) => {
    const campaignId = String(input.campaignId ?? '').trim()
    if (!campaignId) return { success: false, error: 'campaignId is required' }

    const scope = await checkAdsManagementScope()
    if (!scope.ok) return { success: false, error: scope.error }

    const summary =
      `Meta Ads ক্যাম্পেইন duplicate?\nCampaign ID: ${campaignId}\n\n` +
      'Approve করলে PAUSED copy তৈরি হবে (top ad set copy) — Advantage+ learning phase safe।'

    const action = await db.agentPendingAction.create({
      data: {
        conversationId: input.conversationId ? String(input.conversationId) : null,
        type: 'duplicate_campaign',
        payload: { campaignId },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })

    return {
      success: true,
      data: {
        pendingActionId: action.id as string,
        summary,
        actionType: 'duplicate_campaign',
        message: 'Pending owner confirmation before duplicate.',
      },
    }
  },
}

// Soft cap (owner-set): above this daily budget the staged card shows a loud
// warning, but the action is still allowed since it stays behind approval.
const DAILY_BUDGET_SOFT_CAP_BDT = 500

const launch_campaign: AgentTool = {
  name: 'launch_campaign',
  description:
    'Launch a BRAND-NEW Meta Ads campaign for ALMA (Messenger/click-to-Messenger, COD funnel). ' +
    'ALWAYS creates a confirm card — owner must approve. On approval the campaign, ad set, creative and ad ' +
    'are ALL created PAUSED (nothing spends until the owner activates in Ads Manager). Requires ads_management scope. ' +
    'Budget in whole BDT/day; above ৳500/day the card shows a big spend warning. Use for genuinely new campaigns — ' +
    'to scale an existing winner use duplicate_campaign instead.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Campaign name (short, Bangla ok)' },
      dailyBudget: { type: 'number', description: 'Daily budget in whole BDT' },
      message: { type: 'string', description: 'Primary ad text in Bangla (the main copy)' },
      headline: { type: 'string', description: 'Optional short headline under the image' },
      imageUrl: { type: 'string', description: 'REQUIRED public image URL for the creative — a click-to-Messenger ad cannot run without media' },
      page: { type: 'string', description: "'lifestyle' (default) or 'onlineshop'" },
      ageMin: { type: 'number', description: 'Minimum audience age (default 18)' },
      ageMax: { type: 'number', description: 'Maximum audience age (default 65)' },
      audienceId: { type: 'string', description: 'Optional custom/lookalike audience id to TARGET (retargeting or lookalike campaign). From list_audiences. Omit for broad Bangladesh prospecting.' },
      excludeAudienceId: { type: 'string', description: 'Optional custom audience id to EXCLUDE (e.g. exclude existing engagers from a lookalike prospecting campaign).' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['name', 'dailyBudget', 'message', 'imageUrl'],
  },
  handler: async (input) => {
    const name = String(input.name ?? '').trim()
    const message = String(input.message ?? '').trim()
    const dailyBudget = Math.round(Number(input.dailyBudget))
    if (!name) return { success: false, error: 'name is required' }
    if (!message) return { success: false, error: 'message (primary ad text) is required' }
    if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) return { success: false, error: 'dailyBudget must be a positive number' }

    const scope = await checkAdsManagementScope()
    if (!scope.ok) return { success: false, error: scope.error }
    if (!process.env.META_AD_ACCOUNT_ID) return { success: false, error: 'META_AD_ACCOUNT_ID সেট করা নেই' }

    const page = String(input.page ?? 'lifestyle').trim().toLowerCase()
    const headline = input.headline ? String(input.headline).trim() : undefined
    const imageUrl = input.imageUrl ? String(input.imageUrl).trim() : undefined
    if (!imageUrl) return { success: false, error: 'ছবি ছাড়া Click-to-Messenger ক্যাম্পেইন চালু করা যায় না — একটি প্রোডাক্ট ছবির public URL (imageUrl) দিন।' }
    const ageMin = input.ageMin != null ? Math.round(Number(input.ageMin)) : undefined
    const ageMax = input.ageMax != null ? Math.round(Number(input.ageMax)) : undefined
    const audienceId = input.audienceId ? String(input.audienceId).trim() : undefined
    const excludeAudienceId = input.excludeAudienceId ? String(input.excludeAudienceId).trim() : undefined

    const overCap = dailyBudget > DAILY_BUDGET_SOFT_CAP_BDT
    const pageLabel = page === 'onlineshop' ? 'Alma Online Shop' : 'Alma Lifestyle'
    const targetLine = audienceId
      ? `টার্গেট: নির্দিষ্ট audience (${audienceId}) — retargeting/lookalike, বয়স ${ageMin ?? 18}-${ageMax ?? 45}`
      : `টার্গেট: বাংলাদেশ, বয়স ${ageMin ?? 18}-${ageMax ?? 45}`
    const lines = [
      '🚀 নতুন Meta Ads ক্যাম্পেইন চালু করবেন?',
      '',
      `পেজ: ${pageLabel}`,
      `নাম: ${name}`,
      `ধরন: Messenger (click-to-Messenger) — কাস্টমার সরাসরি inbox-এ আসবে`,
      `দৈনিক বাজেট: ৳${dailyBudget.toLocaleString('bn-BD')}/দিন`,
      targetLine,
      excludeAudienceId ? `বাদ: audience ${excludeAudienceId}` : null,
      headline ? `হেডলাইন: ${headline}` : null,
      '',
      `কপি: ${message}`,
      '',
      overCap
        ? `⚠️ সতর্কতা: দৈনিক বাজেট ৳${DAILY_BUDGET_SOFT_CAP_BDT}-এর বেশি (৳${dailyBudget.toLocaleString('bn-BD')})। খরচ বেশি হতে পারে — নিশ্চিত হয়ে Approve করুন।`
        : null,
      '✅ Approve করলে ক্যাম্পেইন + ad set + ad সব PAUSED অবস্থায় তৈরি হবে। কোনো টাকা খরচ হবে না — আপনি Ads Manager থেকে নিজে চালু করবেন।',
    ].filter(Boolean)
    const summary = lines.join('\n')

    const action = await db.agentPendingAction.create({
      data: {
        conversationId: input.conversationId ? String(input.conversationId) : null,
        type: 'launch_campaign',
        payload: { name, dailyBudget, message, headline, imageUrl, page, ageMin, ageMax, audienceId, excludeAudienceId, overCap },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })

    return {
      success: true,
      data: {
        pendingActionId: action.id as string,
        summary,
        overCap,
        message: 'Pending owner confirmation — কিছুই চালু হয়নি, সব approve-এর পেছনে।',
      },
    }
  },
}

const recommend_ad_actions: AgentTool = {
  name: 'recommend_ad_actions',
  description:
    'Analyze active Meta Ads campaigns (spend, CTR, ROAS, 7-day trend) and return ranked Bangla recommendations: ' +
    'scale (+20-30% budget), reduce, kill (pause), duplicate winner, or refresh_creative (File 10). ' +
    'Low-data campaigns → hold. Optionally creates ONE batch approval card when createApprovalCard=true. ' +
    'Execution always via separate confirm cards (update_campaign_budget, pause_campaign, duplicate_campaign, make_ad_creatives). ' +
    'Use this for "বুস্ট করব?"/scale decisions AND "গত ৭ দিনের অ্যাড পারফরম্যান্স / impressions / clicks / CTR কত?" questions. ' +
    'For a performance answer, quote `windowPerformance` (per-campaign impressions/clicks/CTR/spendLabel/status for the last 7 ' +
    'days, PAUSED campaigns included) — it is the REAL data; never say "ডেটা নেই" when windowPerformance has rows. ' +
    '`metaIntelligence` carries Meta\'s own trend / anomaly / opportunity-score / industry + auction benchmarks when available — ' +
    'cite them ("CTR ইন্ডাস্ট্রি গড়ের নিচে…") instead of judging on spend alone. ' +
    'SOURCE: quote `provenance.sourceLabel` verbatim; say "Meta MCP" ONLY if provenance.source === "meta_mcp", otherwise state ' +
    'provenance.degradedReason honestly. MONEY: use windowPerformance[].spendLabel / windowSpendLabel — never ৳ unless BDT.',
  input_schema: {
    type: 'object' as const,
    properties: {
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
      createApprovalCard: {
        type: 'boolean',
        description: 'If true and actionable recs exist, send owner Telegram approval card (default false for chat)',
      },
    },
  },
  handler: async (input) => {
    try {
      const scope = await checkAdsManagementScope()
      if (!scope.ok) return { success: false, error: scope.error }

      const { metrics, recommendations } = await analyzeAdCampaigns()
      await recordRecommendationOutcomes(recommendations)

      // MA2: Meta's official MCP is the preferred intelligence source; the read
      // degrades to the Graph path on its own and reports which one it used, so
      // the head can cite trend/benchmark/anomaly evidence without ever guessing
      // (or fabricating) where the numbers came from.
      const { readAdInsights, provenanceOf } = await import('@/agent/lib/meta-mcp/insights-source')
      const { formatAdSpend } = await import('@/agent/lib/ads/insights')
      const insights = await readAdInsights(7).catch(() => null)

      const summary = formatRecommendationsSummary(recommendations)
      const actionable = recommendations.filter((r) => r.verdict !== 'hold')

      let batchGateId: string | null = null
      if (input.createApprovalCard === true && actionable.length > 0) {
        const batch = await createAdsOptimizerBatchCard({
          conversationId: input.conversationId ? String(input.conversationId) : null,
        })
        batchGateId = batch?.gateId ?? null
      }

      // NOTE: analyzeAdCampaigns() only ever returns ACTIVE (effective_status === 'ACTIVE')
      // campaigns — paused/archived ones are filtered out upstream in
      // fetchActiveCampaignMetrics(). So metrics.length === count of currently LIVE
      // campaigns. The agent must never label these as paused.
      const activeCampaignCount = metrics.length
      const activeNames = metrics.map((m) => m.name)

      let message: string
      // Window performance (status-agnostic) — the AUTHORITATIVE per-campaign
      // impressions/clicks/CTR for a "how did ads perform?" answer. Without this
      // in the tool result the head fell back to recalling numbers from chat
      // history and hedged "usable data নেই / পুরনো চেক" even though the data
      // existed (live-hit 2026-07-17). A paused campaign's window is real history.
      const windowPerformance = (insights?.campaigns ?? []).map((c) => ({
        name: c.name,
        status: c.effectiveStatus,
        spendLabel: formatAdSpend(c.spendWeek, insights?.currency ?? 'USD'),
        impressions: c.impressionsWeek,
        clicks: c.clicksWeek,
        ctrPct: Number(c.ctrWeekPct.toFixed(2)),
      }))

      if (activeCampaignCount === 0) {
        message =
          windowPerformance.length > 0
            ? `এই মুহূর্তে কোনো ACTIVE ক্যাম্পেইন নেই (সব paused), কিন্তু গত ৭ দিনের পারফরম্যান্স আসল ডেটা windowPerformance-এ আছে — quote it (impressions/clicks/CTR সহ, paused লেবেলসহ), "ডেটা নেই" বলবেন না।`
            : 'এই অ্যাড অ্যাকাউন্টে গত ৭ দিনে কোনো ক্যাম্পেইন ডেলিভারি করেনি।'
      } else if (actionable.length > 0) {
        message = `${activeCampaignCount}টি ACTIVE ক্যাম্পেইন চলছে — ${actionable.length}টিতে actionable rec; owner approve ছাড়া budget/spend change হবে না।`
      } else {
        message = `${activeCampaignCount}টি ACTIVE ক্যাম্পেইন চলছে, সবগুলো এখন hold — thin data বা middle performance; noise-এ action নয়।`
      }

      return {
        success: true,
        data: {
          summary,
          // Every spend/budget figure in metrics is in the AD ACCOUNT's billing
          // currency below — report them with THIS currency symbol, never ৳
          // unless the currency is BDT.
          accountCurrency: metrics[0]?.currency ?? insights?.currency ?? 'USD',
          // MA2 provenance — quote `provenance.sourceLabel` verbatim; never say
          // "Meta MCP" unless provenance.source === 'meta_mcp'.
          provenance: insights ? provenanceOf(insights) : null,
          // Live Meta intelligence when the account is inside Meta's MCP rollout;
          // null otherwise (see provenance.degradedReason) — cite it in the
          // boost/scale reasoning instead of judging on spend alone.
          metaIntelligence: insights?.mcp ?? null,
          windowSpendLabel: insights?.totalSpendLabel ?? null,
          // The real last-7-days per-campaign performance (paused-inclusive) —
          // this is what a "impressions/clicks/CTR কত?" question is answered from.
          windowPerformance,
          campaignCount: activeCampaignCount,
          activeCampaignCount,
          activeCampaignNames: activeNames,
          actionableCount: actionable.length,
          recommendations: recommendations.map((r) => ({
            campaignId: r.campaignId,
            name: r.name,
            verdict: r.verdict,
            reason: r.reason,
            confidence: r.confidence,
            action: r.action,
            metrics: r.metrics,
          })),
          batchPendingActionId: batchGateId,
          message,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const list_audiences: AgentTool = {
  name: 'list_audiences',
  description:
    'READ-ONLY: list the ad account\'s existing Meta custom + lookalike audiences with approximate sizes and status. ' +
    'Use before creating a retargeting/lookalike audience (avoid duplicates) and to pick a source audience id for a lookalike. ' +
    'No confirm card — pure read.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    const result = await listCustomAudiences()
    if (!result.success) return { success: false, error: result.error }
    const audiences = result.audiences ?? []
    const summary = audiences.length === 0
      ? 'এই অ্যাড অ্যাকাউন্টে এখনো কোনো custom/lookalike audience তৈরি হয়নি।'
      : audiences
          .map((a) => {
            const size = a.approxLower != null
              ? `~${a.approxLower.toLocaleString('en-US')}${a.approxUpper != null ? `–${a.approxUpper.toLocaleString('en-US')}` : '+'}`
              : 'size pending'
            return `• ${a.name} [${a.subtype}] — ${size} জন (${a.deliveryStatus ?? a.operationStatus ?? 'status?'}) · id ${a.id}`
          })
          .join('\n')
    return {
      success: true,
      data: { count: audiences.length, audiences, summary },
    }
  },
}

const create_retargeting_audience: AgentTool = {
  name: 'create_retargeting_audience',
  description:
    'Create a WARM retargeting audience — people who engaged with the ALMA Facebook page (posts, ads, Messenger, CTA clicks) ' +
    'over the last N days. ALWAYS creates a confirm card — owner must approve. Creating an audience does NOT spend money; ' +
    'it only defines who a future campaign can target. Requires ads_management scope. ' +
    'After approval, use launch_campaign with audienceId to actually run retargeting ads (still PAUSED).',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Audience name (short, e.g. "Page Engagers 365d")' },
      page: { type: 'string', description: "'lifestyle' (default) or 'onlineshop'" },
      retentionDays: { type: 'number', description: 'Look-back window in days (1-365, default 365 = widest warm pool)' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['name'],
  },
  handler: async (input) => {
    const name = String(input.name ?? '').trim()
    if (!name) return { success: false, error: 'name is required' }

    const scope = await checkAdsManagementScope()
    if (!scope.ok) return { success: false, error: scope.error }

    const page = String(input.page ?? 'lifestyle').trim().toLowerCase()
    const retentionDays = input.retentionDays != null
      ? Math.min(365, Math.max(1, Math.round(Number(input.retentionDays))))
      : 365
    const pageLabel = page === 'onlineshop' ? 'Alma Online Shop' : 'Alma Lifestyle'

    const summary = [
      '🎯 রিটার্গেটিং Audience তৈরি করবেন?',
      '',
      `নাম: ${name}`,
      `উৎস: ${pageLabel} পেজে যারা engage করেছে (পোস্ট/অ্যাড/Messenger/CTA)`,
      `সময়সীমা: গত ${retentionDays} দিন`,
      '',
      '✅ Approve করলে শুধু audience তৈরি হবে — কোনো টাকা খরচ হবে না। পরে এটাকে target করে retargeting ad চালানো যাবে (সব PAUSED)।',
    ].join('\n')

    const action = await db.agentPendingAction.create({
      data: {
        conversationId: input.conversationId ? String(input.conversationId) : null,
        type: 'create_retargeting_audience',
        payload: { name, page, retentionDays },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })

    return {
      success: true,
      data: { pendingActionId: action.id as string, summary, message: 'Pending owner confirmation — কোনো audience এখনো তৈরি হয়নি।' },
    }
  },
}

const create_lookalike_audience: AgentTool = {
  name: 'create_lookalike_audience',
  description:
    'Create a LOOKALIKE audience — Meta finds NEW people in Bangladesh similar to a warm source audience. ' +
    'First call list_audiences to get a valid sourceAudienceId (an engagement/custom audience with enough people; Meta needs ~100+). ' +
    'ALWAYS creates a confirm card. Creating it does NOT spend money. Requires ads_management scope. ' +
    'After approval, use launch_campaign with that lookalike audienceId to run prospecting ads (still PAUSED).',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Lookalike name (short, e.g. "LAL 1% BD — Page Engagers")' },
      sourceAudienceId: { type: 'string', description: 'Source custom-audience id to model on (from list_audiences)' },
      ratioPercent: { type: 'number', description: 'Lookalike size 1-20 (%). Smaller = tighter match. Default 1.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['name', 'sourceAudienceId'],
  },
  handler: async (input) => {
    const name = String(input.name ?? '').trim()
    const sourceAudienceId = String(input.sourceAudienceId ?? '').trim()
    if (!name) return { success: false, error: 'name is required' }
    if (!sourceAudienceId) return { success: false, error: 'sourceAudienceId is required (call list_audiences first)' }

    const scope = await checkAdsManagementScope()
    if (!scope.ok) return { success: false, error: scope.error }

    const ratioPercent = input.ratioPercent != null
      ? Math.min(20, Math.max(1, Math.round(Number(input.ratioPercent))))
      : 1
    const ratio = ratioPercent / 100

    const summary = [
      '👥 Lookalike Audience তৈরি করবেন?',
      '',
      `নাম: ${name}`,
      `উৎস audience id: ${sourceAudienceId}`,
      `আকার: বাংলাদেশের জনসংখ্যার ${ratioPercent}% (similarity — ছোট মানে বেশি মিল)`,
      '',
      '✅ Approve করলে শুধু lookalike audience তৈরি হবে — কোনো টাকা খরচ হবে না। উৎসে যথেষ্ট মানুষ (~১০০+) না থাকলে Meta প্রত্যাখ্যান করতে পারে।',
    ].join('\n')

    const action = await db.agentPendingAction.create({
      data: {
        conversationId: input.conversationId ? String(input.conversationId) : null,
        type: 'create_lookalike_audience',
        payload: { name, sourceAudienceId, ratio, ratioPercent, country: 'BD' },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })

    return {
      success: true,
      data: { pendingActionId: action.id as string, summary, message: 'Pending owner confirmation — কোনো audience এখনো তৈরি হয়নি।' },
    }
  },
}

const ads_campaign_plan: AgentTool = {
  name: 'ads_campaign_plan',
  description:
    'Phase 45 pre-flight for a new campaign (READ-ONLY — creates nothing): validates the spec against the approved ' +
    'growth-brief budget cap, supported objectives (' +
    SUPPORTED_OBJECTIVES.join(', ') +
    '; explicitly-unsupported: ' +
    KNOWN_UNSUPPORTED_OBJECTIVES.join(', ') +
    ' — no faked Ads Manager parity), UTM convention, and tracking QA (pixel/CAPI health). Returns errors/warnings, the ' +
    'projected monthly spend, the owner-readable diff, and the idempotency key that guarantees a retry cannot create a ' +
    'duplicate. Run this BEFORE launch_campaign; the launch itself still goes through its approval card and is created PAUSED.',
  input_schema: {
    type: 'object' as const,
    properties: {
      spec: {
        type: 'object',
        description:
          'CampaignPlanSpec: {experimentId (required), objective ("messenger_cod"), name, dailyBudgetBdt, page, message, headline, imageUrl, ageMin, ageMax, audienceId, excludeAudienceId, utm}',
      },
    },
    required: ['spec'],
  },
  handler: async (input) => {
    try {
      const spec = input.spec as unknown as CampaignPlanSpec
      const [brief, capi] = await Promise.all([
        getApprovedBrief('ALMA_LIFESTYLE').catch(() => null),
        capiHealth().catch(() => null),
      ])
      spec.trackingQa = { pixelProven: Boolean(capi?.configured && (capi?.last7d.sent ?? 0) > 0), note: capi ? undefined : 'capi health unreadable' }
      const validation = validateCampaignSpec(spec, {
        monthlyBudgetCapBdt: brief?.brief.economics?.monthlyBudgetCapBdt ?? null,
      })
      return {
        success: true,
        data: {
          validation,
          diff: buildCampaignDiff(spec, validation),
          idempotencyKey: campaignIdempotencyKey(spec),
          briefVersion: brief?.version ?? null,
          note: validation.ok
            ? 'Spec valid — এবার launch_campaign দিয়ে approval card তুলুন (তৈরি হবে PAUSED)।'
            : 'Spec আটকেছে — errors ঠিক করে আবার plan করুন।',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const ADS_TOOLS: AgentTool[] = [
  pause_campaign,
  update_campaign_budget,
  duplicate_campaign,
  launch_campaign,
  recommend_ad_actions,
  list_audiences,
  create_retargeting_audience,
  create_lookalike_audience,
  ads_campaign_plan,
]

export const ADS_ROLE_PROMPT = `
## META ADS (Advantage+ era)
Read: recommend_ad_actions — ranked Bangla verdicts per campaign (scale/reduce/kill/duplicate/refresh_creative/hold). Never manual audience/bid micro-management.
Write (confirm card ONLY): pause_campaign, update_campaign_budget (+20-30% max step), duplicate_campaign (PAUSED copy), launch_campaign (brand-new Messenger/CTWA campaign — campaign+ad set+creative+ad all created PAUSED on approval, ৳500/day soft cap shows a spend warning above threshold).
Creative fatigue → refresh_creative → make_ad_creatives (File 10) with angleHint.
Scaling a proven winner → duplicate_campaign (copy existing). Net-new offer/angle with no existing campaign → ads_campaign_plan (validate vs brief cap + UTM + tracking QA, get diff + idempotency) THEN launch_campaign.
Low spend/impressions → hold. ROAS is directional for COD/Messenger — cross-check orders over time.

## RETARGETING + LOOKALIKE (audiences)
Read: list_audiences — existing custom/lookalike audiences with sizes (run first to avoid duplicates + to get a source id).
Write (confirm card ONLY): create_retargeting_audience (warm page/Messenger engagers, 1-365d window — no spend), create_lookalike_audience (NEW Bangladesh people similar to a warm source; needs a sourceAudienceId from list_audiences, source must have ~100+ people or Meta rejects).
Run ads to an audience → launch_campaign with audienceId (retargeting/lookalike) — still created PAUSED. Use excludeAudienceId to keep a lookalike prospecting campaign off existing engagers.
Warm retargeting usually beats cold prospecting for COD — suggest building a page-engager audience before scaling cold spend. Creating audiences never spends; only an ACTIVE campaign does.
`
