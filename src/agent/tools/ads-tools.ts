/**
 * Phase 10 — Ads write v1 (pause + budget update, confirm cards only).
 */
import { prisma } from '@/lib/prisma'
import { checkAdsManagementScope } from '@/agent/lib/meta-ads'
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

export const ADS_TOOLS: AgentTool[] = [pause_campaign, update_campaign_budget]
