/**
 * Phase 10 + File 11 — Ads write + closed-loop optimizer recommendations.
 */
import { prisma } from '@/lib/prisma'
import { checkAdsManagementScope } from '@/agent/lib/meta-ads'
import {
  analyzeAdCampaigns,
  createAdsOptimizerBatchCard,
  formatRecommendationsSummary,
  recordRecommendationOutcomes,
} from '@/agent/lib/ads/optimizer'
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
      conversationId: { type: 'string' },
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
      campaignId: { type: 'string' },
      dailyBudget: { type: 'number', description: 'New daily budget in whole BDT' },
      conversationId: { type: 'string' },
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
      conversationId: { type: 'string' },
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

const recommend_ad_actions: AgentTool = {
  name: 'recommend_ad_actions',
  description:
    'Analyze active Meta Ads campaigns (spend, CTR, ROAS, 7-day trend) and return ranked Bangla recommendations: ' +
    'scale (+20-30% budget), reduce, kill (pause), duplicate winner, or refresh_creative (File 10). ' +
    'Low-data campaigns → hold. Optionally creates ONE batch approval card when createApprovalCard=true. ' +
    'Execution always via separate confirm cards (update_campaign_budget, pause_campaign, duplicate_campaign, make_ad_creatives).',
  input_schema: {
    type: 'object' as const,
    properties: {
      conversationId: { type: 'string' },
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

      const summary = formatRecommendationsSummary(recommendations)
      const actionable = recommendations.filter((r) => r.verdict !== 'hold')

      let batchGateId: string | null = null
      if (input.createApprovalCard === true && actionable.length > 0) {
        const batch = await createAdsOptimizerBatchCard({
          conversationId: input.conversationId ? String(input.conversationId) : null,
        })
        batchGateId = batch?.gateId ?? null
      }

      return {
        success: true,
        data: {
          summary,
          campaignCount: metrics.length,
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
          message:
            actionable.length > 0
              ? `${actionable.length}টি actionable rec — owner approve ছাড়া budget/spend change হবে না।`
              : 'সব ক্যাম্পেইন hold — thin data বা middle performance; noise-এ action নয়।',
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
  recommend_ad_actions,
]

export const ADS_ROLE_PROMPT = `
## META ADS (Advantage+ era)
Read: recommend_ad_actions — ranked Bangla verdicts per campaign (scale/reduce/kill/duplicate/refresh_creative/hold). Never manual audience/bid micro-management.
Write (confirm card ONLY): pause_campaign, update_campaign_budget (+20-30% max step), duplicate_campaign (PAUSED copy).
Creative fatigue → refresh_creative → make_ad_creatives (File 10) with angleHint.
Low spend/impressions → hold. ROAS is directional for COD/Messenger — cross-check orders over time.
`
