/**
 * Closed-loop ad optimizer — read metrics, classify, Sonnet-ranked Bangla recommendations.
 * Execution stays owner-approved via pause_campaign / update_campaign_budget / duplicate_campaign / make_ad_creatives.
 */
import { agentSmartText } from '@/agent/lib/llm-text'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { sendOwnerApprovalCard } from '@/agent/lib/telegram-owner-notify'
import {
  fetchActiveCampaignMetrics,
  fetchCampaignDailyBudgetBdt,
  type CampaignMetrics,
} from '@/agent/lib/ads/insights'
import {
  getTopCreativeAngles,
  logCreativePerformance,
  writeWinningAngleToPlaybook,
} from '@/agent/lib/ads/creative-performance'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type AdVerdict = 'scale' | 'hold' | 'reduce' | 'kill' | 'refresh_creative' | 'duplicate'

export type AdRecommendationAction =
  | { type: 'budget'; deltaPct: number; newDailyBudgetBdt?: number }
  | { type: 'pause' }
  | { type: 'duplicate' }
  | { type: 'new_creative'; angleHint: string; productCode?: string }

export interface AdRecommendation {
  campaignId: string
  name: string
  verdict: AdVerdict
  reason: string
  action?: AdRecommendationAction
  confidence: 1 | 2 | 3 | 4 | 5
  metrics?: {
    spendWeek: number
    roasWeek: number
    ctrTodayPct: number
    ctrWeekPct: number
    dailyBudgetBdt: number
    status: string
    objective?: string
    currency?: string
  }
}

export const OPTIMIZER_THRESHOLDS = {
  TARGET_ROAS: 2.0,
  SCALE_ROAS: 2.5,
  WINNER_ROAS: 3.2,
  KILL_ROAS: 1.0,
  SCALE_DELTA_PCT: 25,
  REDUCE_DELTA_PCT: -25,
  CTR_FATIGUE_RATIO: 0.75,
} as const

export function classifyCampaignMetrics(m: CampaignMetrics): AdVerdict {
  return guardrailVerdict(m)
}

function guardrailVerdict(m: CampaignMetrics): AdVerdict {
  if (!m.hasEnoughData) return 'hold'

  const { TARGET_ROAS, SCALE_ROAS, WINNER_ROAS, KILL_ROAS, CTR_FATIGUE_RATIO } = OPTIMIZER_THRESHOLDS
  const ctrStable = m.ctrWeekPct <= 0 || m.ctrTodayPct >= m.ctrWeekPct * CTR_FATIGUE_RATIO

  if (m.roasWeek >= WINNER_ROAS && ctrStable) return 'duplicate'
  if (m.roasWeek >= SCALE_ROAS && ctrStable) return 'scale'
  if (m.roasWeek >= TARGET_ROAS && !ctrStable) return 'refresh_creative'
  if (m.roasWeek < KILL_ROAS && m.spendWeek >= 1000) return 'kill'
  if (m.roasWeek < TARGET_ROAS && m.spendWeek >= 500) return 'reduce'
  return 'hold'
}

function buildAction(m: CampaignMetrics, verdict: AdVerdict): AdRecommendationAction | undefined {
  if (verdict === 'hold') return undefined
  if (verdict === 'kill') return { type: 'pause' }
  if (verdict === 'duplicate') return { type: 'duplicate' }
  if (verdict === 'refresh_creative') {
    return {
      type: 'new_creative',
      angleHint: 'CTR fatigue — urgency/scarcity বা emotional family angle চেষ্টা করুন',
    }
  }
  if (verdict === 'scale' || verdict === 'reduce') {
    const deltaPct = verdict === 'scale'
      ? OPTIMIZER_THRESHOLDS.SCALE_DELTA_PCT
      : OPTIMIZER_THRESHOLDS.REDUCE_DELTA_PCT
    const base = m.dailyBudgetBdt > 0 ? m.dailyBudgetBdt : Math.max(300, Math.round(m.spendWeek / 7))
    const newDailyBudgetBdt = Math.max(200, roundMoney(base * (1 + deltaPct / 100)))
    return { type: 'budget', deltaPct, newDailyBudgetBdt }
  }
  return undefined
}

function confidenceFor(m: CampaignMetrics, verdict: AdVerdict): 1 | 2 | 3 | 4 | 5 {
  if (verdict === 'hold') return m.hasEnoughData ? 2 : 1
  if (!m.hasEnoughData) return 1
  if (m.spendWeek >= 3000 && m.impressionsWeek >= 5000) return 5
  if (m.spendWeek >= 1500) return 4
  return 3
}

function metricsTable(metrics: CampaignMetrics[]): string {
  return metrics.map((m) =>
    JSON.stringify({
      id: m.campaignId,
      name: m.name,
      spendWeek: Math.round(m.spendWeek),
      currency: m.currency,
      objective: m.objective,
      roasWeek: Number(m.roasWeek.toFixed(2)),
      ctrTodayPct: Number(m.ctrTodayPct.toFixed(2)),
      ctrWeekPct: Number(m.ctrWeekPct.toFixed(2)),
      dailyBudgetBdt: m.dailyBudgetBdt,
      enoughData: m.hasEnoughData,
      guardrail: guardrailVerdict(m),
    }),
  ).join('\n')
}

async function enrichWithSonnet(
  metrics: CampaignMetrics[],
  draft: AdRecommendation[],
): Promise<AdRecommendation[]> {
  if (draft.length === 0) return draft

  const topAngles = await getTopCreativeAngles(3)
  // Anthropic-or-Gemini (owner: Gemini replaces Sonnet for now). The old direct
  // Anthropic call 400'd on exhausted credits and killed recommend_ad_actions.
  const raw = await agentSmartText({
    system:
      'You are ALMA Lifestyle Meta Ads optimizer (Bangladesh, COD/Messenger funnel). ' +
      'Output ONLY JSON array matching input campaigns. Each item: {"campaignId","verdict","reason","confidence"}. ' +
      'reason = Bangla, cite numbers (ROAS, CTR, spend). Spend numbers are in each campaign\'s `currency` field (this account bills in USD) — ALWAYS write spend with that currency symbol, NEVER ৳ unless currency is BDT. Never recommend manual targeting/bidding — Advantage+ only. Each campaign has an `objective`: for MESSAGES/ENGAGEMENT campaigns there is NO purchase ROAS or Pixel funnel — judge by messaging conversations/engagement and NEVER advise Pixel/website/conversion fixes for them; reserve ROAS/Pixel talk for SALES/CONVERSIONS objectives. If a metric is missing, say so honestly instead of guessing. ' +
      'If insufficient data, verdict MUST be hold. Do not override hold guardrails to scale/kill.',
    prompt:
      `Metrics:\n${metricsTable(metrics)}\n\n` +
      `Draft recommendations:\n${JSON.stringify(draft.map((d) => ({ campaignId: d.campaignId, verdict: d.verdict })))}\n\n` +
      `Winning creative angles from history: ${JSON.stringify(topAngles)}\n` +
      'Rank by priority (scale winners first, then refresh, reduce, kill). Bangla reasons.',
    maxTokens: 1800,
    costLabel: 'ads_optimizer_enrich',
  })
  try {
    const match = raw.match(/\[[\s\S]*\]/)
    const parsed = JSON.parse(match?.[0] ?? '[]') as Array<{
      campaignId?: string
      verdict?: AdVerdict
      reason?: string
      confidence?: number
    }>
    const byId = new Map(parsed.map((p) => [String(p.campaignId), p]))
    return draft.map((d) => {
      const llm = byId.get(d.campaignId)
      if (!llm) return d
      const llmVerdict = llm.verdict ?? d.verdict
      const metricsRow = metrics.find((m) => m.campaignId === d.campaignId)!
      const forcedHold = !metricsRow.hasEnoughData && llmVerdict !== 'hold'
      const verdict = forcedHold ? 'hold' : llmVerdict
      return {
        ...d,
        verdict,
        reason: String(llm.reason ?? d.reason).trim(),
        confidence: Math.min(5, Math.max(1, Math.round(Number(llm.confidence ?? d.confidence)))) as 1 | 2 | 3 | 4 | 5,
        action: buildAction(metricsRow, verdict),
      }
    })
  } catch {
    return draft
  }
}

function curSym(m: CampaignMetrics): string {
  return m.currency === 'BDT' ? '৳' : m.currency === 'USD' ? '$' : `${m.currency} `
}

function draftReason(m: CampaignMetrics, verdict: AdVerdict): string {
  const roas = m.roasWeek.toFixed(1)
  const ctrT = m.ctrTodayPct.toFixed(2)
  const ctrW = m.ctrWeekPct.toFixed(2)
  switch (verdict) {
    case 'scale':
      return `ROAS ${roas}x, CTR ${ctrT}% (৭-দিন ${ctrW}%) — স্থিতিশীল; বাজেট +${OPTIMIZER_THRESHOLDS.SCALE_DELTA_PCT}% (ছোট ধাপে scale)।`
    case 'duplicate':
      return `ROAS ${roas}x — স্পষ্ট winner; নতুন ad set-এ duplicate করে scale করুন (winner over-edit করবেন না)।`
    case 'refresh_creative':
      return `ROAS ${roas}x কিন্তু CTR ${ctrT}% vs গড় ${ctrW}% — creative fatigue; File 10 দিয়ে নতুন angle।`
    case 'reduce':
      return `ROAS ${roas}x (লক্ষ্য ${OPTIMIZER_THRESHOLDS.TARGET_ROAS}x-এর নিচে), spend ${curSym(m)}${Math.round(m.spendWeek)} — বাজেট ${OPTIMIZER_THRESHOLDS.REDUCE_DELTA_PCT}% কমান।`
    case 'kill':
      return `ROAS ${roas}x, spend ${curSym(m)}${Math.round(m.spendWeek)} — breakeven-এর নিচে; pause করুন।`
    default:
      return m.hasEnoughData
        ? `ROAS ${roas}x — এখন hold; আরও ডেটা দেখুন।`
        : `Spend/ impression কম (${curSym(m)}${Math.round(m.spendWeek)} / ${Math.round(m.impressionsWeek)}) — noise-এ action নয়, hold।`
  }
}

export async function analyzeAdCampaigns(): Promise<{
  metrics: CampaignMetrics[]
  recommendations: AdRecommendation[]
}> {
  const metrics = await fetchActiveCampaignMetrics()
  if (!metrics.length) {
    return { metrics: [], recommendations: [] }
  }

  const draft: AdRecommendation[] = metrics.map((m) => {
    const verdict = guardrailVerdict(m)
    return {
      campaignId: m.campaignId,
      name: m.name,
      verdict,
      reason: draftReason(m, verdict),
      action: buildAction(m, verdict),
      confidence: confidenceFor(m, verdict),
      metrics: {
        spendWeek: m.spendWeek,
        roasWeek: m.roasWeek,
        ctrTodayPct: m.ctrTodayPct,
        ctrWeekPct: m.ctrWeekPct,
        dailyBudgetBdt: m.dailyBudgetBdt,
        status: m.effectiveStatus,
        objective: m.objective,
        currency: m.currency,
      },
    }
  })

  // Fail-open: if BOTH LLM paths are down, the deterministic guardrail draft is
  // still a valid answer — the tool must never die on an enrichment failure.
  const enriched = await enrichWithSonnet(metrics, draft).catch((err) => {
    console.warn('[ads-optimizer] enrichment failed, using guardrail draft:', err instanceof Error ? err.message : err)
    return draft
  })
  const actionable = enriched.filter((r) => r.verdict !== 'hold')
  const hold = enriched.filter((r) => r.verdict === 'hold')
  const ranked = [...actionable.sort((a, b) => b.confidence - a.confidence), ...hold]

  return { metrics, recommendations: ranked }
}

export function formatRecommendationsSummary(recommendations: AdRecommendation[]): string {
  if (!recommendations.length) return 'কোনো সক্রিয় ক্যাম্পেইন নেই।'
  const lines = recommendations.map((r, i) => {
    const icon = r.verdict === 'hold' ? '⏸' : r.verdict === 'scale' ? '📈' : r.verdict === 'kill' ? '🛑' : r.verdict === 'duplicate' ? '📋' : r.verdict === 'refresh_creative' ? '🎨' : '📉'
    return `${i + 1}. ${icon} *${r.name}* — ${r.verdict.toUpperCase()} (conf ${r.confidence}/5)\n   ${r.reason}`
  })
  return lines.join('\n\n')
}

export type AdsOptimizerBatchPayload = {
  recommendations: AdRecommendation[]
  executedIndices: number[]
  conversationId?: string | null
}

export function buildAdsOptimizerKeyboard(
  gateId: string,
  payload: AdsOptimizerBatchPayload,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = []
  payload.recommendations.forEach((r, idx) => {
    if (r.verdict === 'hold') return
    if (payload.executedIndices.includes(idx)) return
    const label = `${r.verdict === 'scale' ? '📈' : r.verdict === 'kill' ? '🛑' : r.verdict === 'duplicate' ? '📋' : r.verdict === 'refresh_creative' ? '🎨' : '📉'} ${r.name.slice(0, 18)}`
    rows.push([{ text: label, callback_data: `ads_opt_exec:${gateId}:${idx}` }])
  })
  rows.push([{ text: '⏭ সব skip', callback_data: `reject:${gateId}` }])
  return { inline_keyboard: rows }
}

export async function createAdsOptimizerBatchCard(opts?: {
  conversationId?: string | null
}): Promise<{ gateId: string; summary: string; actionableCount: number } | null> {
  const { recommendations } = await analyzeAdCampaigns()
  const actionable = recommendations.filter((r) => r.verdict !== 'hold')
  if (!actionable.length) {
    return null
  }

  const payload: AdsOptimizerBatchPayload = {
    recommendations,
    executedIndices: [],
    conversationId: opts?.conversationId ?? null,
  }
  const summary =
    '🎯 *Ad Optimizer — owner approval*\n\n' +
    formatRecommendationsSummary(recommendations) +
    '\n\n✅ একটি rec ট্যাপ করলে confirm card আসবে — auto-spend হবে না।'

  const gate = await db.agentPendingAction.create({
    data: {
      conversationId: opts?.conversationId ?? null,
      type: 'ads_optimizer_batch',
      payload,
      summary,
      costEstimate: 0,
      status: 'pending',
    },
  })

  await sendOwnerApprovalCard({
    summary,
    pendingActionId: gate.id,
    reply_markup: buildAdsOptimizerKeyboard(gate.id, payload),
  }).catch(() => {})

  return { gateId: gate.id, summary, actionableCount: actionable.length }
}

/** Create confirm-card pending action for one recommendation (uses pause_campaign / update_campaign_budget paths). */
export async function createExecutionPendingAction(
  rec: AdRecommendation,
  conversationId?: string | null,
): Promise<{ pendingActionId: string; summary: string; actionType: string }> {
  if (rec.verdict === 'hold' || !rec.action) {
    throw new Error('hold_rec_has_no_execution')
  }

  if (rec.action.type === 'pause') {
    const summary = `Meta Ads ক্যাম্পেইন পজ?\n*${rec.name}*\nCampaign ID: ${rec.campaignId}\n\n${rec.reason}\n\nApprove → pause_campaign`
    const action = await db.agentPendingAction.create({
      data: {
        conversationId: conversationId ?? null,
        type: 'pause_campaign',
        payload: { campaignId: rec.campaignId, sourceRecommendation: rec },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })
    return { pendingActionId: action.id, summary, actionType: 'pause_campaign' }
  }

  if (rec.action.type === 'budget') {
    let newBudget = rec.action.newDailyBudgetBdt
    if (!newBudget) {
      const current = rec.metrics?.dailyBudgetBdt || await fetchCampaignDailyBudgetBdt(rec.campaignId)
      const delta = rec.action.deltaPct
      newBudget = Math.max(200, roundMoney((current || 300) * (1 + delta / 100)))
    }
    const summary =
      `Meta Ads বাজেট আপডেট?\n*${rec.name}*\nCampaign ID: ${rec.campaignId}\n` +
      `নতুন বাজেট: ৳${newBudget.toLocaleString('bn-BD')}/দিন (${rec.action.deltaPct > 0 ? '+' : ''}${rec.action.deltaPct}%)\n\n${rec.reason}\n\nApprove → update_campaign_budget`
    const action = await db.agentPendingAction.create({
      data: {
        conversationId: conversationId ?? null,
        type: 'update_campaign_budget',
        payload: { campaignId: rec.campaignId, dailyBudget: newBudget, sourceRecommendation: rec },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })
    return { pendingActionId: action.id, summary, actionType: 'update_campaign_budget' }
  }

  if (rec.action.type === 'duplicate') {
    const summary =
      `ক্যাম্পেইন duplicate (paused)?\n*${rec.name}*\nCampaign ID: ${rec.campaignId}\n\n${rec.reason}\n\nApprove → duplicate_campaign (fresh ad set copy)`
    const action = await db.agentPendingAction.create({
      data: {
        conversationId: conversationId ?? null,
        type: 'duplicate_campaign',
        payload: { campaignId: rec.campaignId, sourceRecommendation: rec },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })
    return { pendingActionId: action.id, summary, actionType: 'duplicate_campaign' }
  }

  if (rec.action.type === 'new_creative') {
    const summary =
      `নতুন ad creative brief?\n*${rec.name}*\n${rec.reason}\n\nAngle hint: ${rec.action.angleHint}\n\nApprove → make_ad_creatives (File 10) suggestion card`
    const action = await db.agentPendingAction.create({
      data: {
        conversationId: conversationId ?? null,
        type: 'ads_creative_brief',
        payload: {
          campaignId: rec.campaignId,
          campaignName: rec.name,
          angleHint: rec.action.angleHint,
          productCode: rec.action.productCode ?? null,
          sourceRecommendation: rec,
        },
        summary,
        costEstimate: 0,
        status: 'pending',
      },
    })
    return { pendingActionId: action.id, summary, actionType: 'ads_creative_brief' }
  }

  throw new Error('unknown_action_type')
}

export async function executeAdsOptimizerRec(
  gateId: string,
  recIndex: number,
): Promise<{ pendingActionId: string; summary: string; actionType: string }> {
  const gate = await db.agentPendingAction.findUnique({ where: { id: gateId } })
  if (!gate || gate.type !== 'ads_optimizer_batch') throw new Error('invalid_optimizer_gate')

  const payload = gate.payload as AdsOptimizerBatchPayload
  const rec = payload.recommendations[recIndex]
  if (!rec) throw new Error('rec_not_found')

  const exec = await createExecutionPendingAction(rec, payload.conversationId ?? gate.conversationId)
  payload.executedIndices = [...(payload.executedIndices ?? []), recIndex]

  await db.agentPendingAction.update({
    where: { id: gateId },
    data: {
      payload,
      summary: gate.summary + `\n\n✓ Queued: ${rec.name} → ${exec.actionType}`,
    },
  })

  await sendOwnerApprovalCard({
    summary: exec.summary,
    pendingActionId: exec.pendingActionId,
  }).catch(() => {})

  return exec
}

export async function recordRecommendationOutcomes(recommendations: AdRecommendation[]): Promise<void> {
  for (const rec of recommendations) {
    if (rec.verdict === 'hold' || !rec.metrics) continue
    const angle = rec.action?.type === 'new_creative' ? rec.action.angleHint : rec.verdict
    await logCreativePerformance({
      campaignId: rec.campaignId,
      campaignName: rec.name,
      angle,
      roas: rec.metrics.roasWeek,
      ctr: rec.metrics.ctrTodayPct,
      spendBdt: rec.metrics.spendWeek,
      verdict: rec.verdict,
    })
    if (rec.metrics.roasWeek >= OPTIMIZER_THRESHOLDS.SCALE_ROAS && rec.verdict !== 'kill') {
      await writeWinningAngleToPlaybook({
        angle,
        roas: rec.metrics.roasWeek,
        ctr: rec.metrics.ctrTodayPct,
        campaignName: rec.name,
      })
    }
  }
}

// Execution references — grep verification: update_campaign_budget, pause_campaign
export const EXECUTION_TOOLS = {
  scale: 'update_campaign_budget',
  reduce: 'update_campaign_budget',
  kill: 'pause_campaign',
  duplicate: 'duplicate_campaign',
  refresh_creative: 'make_ad_creatives',
} as const
