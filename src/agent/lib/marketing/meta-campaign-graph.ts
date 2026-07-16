/**
 * Phase 45 — the professional Meta campaign lifecycle:
 *
 *   approved brief → experiment → spec validation (objective/budget/UTM/
 *   tracking QA) → owner-readable diff → idempotent create-PAUSED →
 *   point-of-risk activation approval (owner, in Ads Manager or via card) →
 *   monitor → optimize/stop → learning
 *
 * Discipline encoded here:
 * - Only objectives/paths PROVEN by the current code + assets are supported;
 *   everything else is explicitly `unsupported`, never faked.
 * - A duplicate/retried request CANNOT create two campaigns: a deterministic
 *   idempotency key is claimed (kv row) before any Graph write.
 * - Every mutation is change-logged (AgentAuditLog) and tied to an experiment.
 * - Automated recommendation ≠ automated spending: nothing here activates a
 *   campaign; creations are PAUSED by the underlying client.
 */
import { createHash } from 'crypto'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { launchCampaign, type LaunchCampaignSpec } from '@/agent/lib/meta-ads'
import { validateUtm, type UtmParams } from '@/agent/lib/marketing/utm'
import { getApprovedBrief } from '@/agent/lib/marketing/growth-brief'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** What this codebase can actually create today (Click-to-Messenger COD funnel). */
export const SUPPORTED_OBJECTIVES = ['messenger_cod'] as const
/** Objectives a pro would ask about that we deliberately mark unsupported (no faked parity). */
export const KNOWN_UNSUPPORTED_OBJECTIVES = [
  'catalog_sales',
  'website_conversions',
  'lead_form',
  'video_views',
  'store_traffic',
  'app_installs',
] as const

export interface CampaignPlanSpec {
  /** Every campaign belongs to an experiment — no experiment, no campaign. */
  experimentId: string
  objective: string
  name: string
  dailyBudgetBdt: number
  page?: string
  message: string
  headline?: string
  imageUrl?: string
  ageMin?: number
  ageMax?: number
  audienceId?: string
  excludeAudienceId?: string
  utm?: Partial<UtmParams>
  /** From capability audit / capiHealth — pixel pipeline state at plan time. */
  trackingQa?: { pixelProven: boolean; note?: string }
}

export interface CampaignValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  /** Whole-taka monthly projection of this daily budget. */
  projectedMonthlyBdt: number
}

/**
 * Validate a campaign plan against the approved brief (budget boundary),
 * supported objectives, UTM convention, and tracking QA. Pure given inputs.
 */
export function validateCampaignSpec(
  spec: CampaignPlanSpec,
  context: { monthlyBudgetCapBdt: number | null; otherPlannedMonthlyBdt?: number },
): CampaignValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!spec.experimentId?.trim()) errors.push('experimentId required — every campaign is an experiment')
  if (!(SUPPORTED_OBJECTIVES as readonly string[]).includes(spec.objective)) {
    errors.push(
      (KNOWN_UNSUPPORTED_OBJECTIVES as readonly string[]).includes(spec.objective)
        ? `objective "${spec.objective}" is UNSUPPORTED today (no faked Ads Manager parity) — supported: ${SUPPORTED_OBJECTIVES.join(', ')}`
        : `unknown objective "${spec.objective}" — supported: ${SUPPORTED_OBJECTIVES.join(', ')}`,
    )
  }
  if (!spec.message?.trim()) errors.push('primary ad message required')
  if (!spec.imageUrl?.trim()) errors.push('creative image URL required (Click-to-Messenger needs media)')
  if (!Number.isFinite(spec.dailyBudgetBdt) || spec.dailyBudgetBdt < 100) errors.push('dailyBudgetBdt must be ≥ ৳100')

  const projectedMonthlyBdt = roundMoney(Math.max(0, spec.dailyBudgetBdt) * 30 + (context.otherPlannedMonthlyBdt ?? 0))
  if (context.monthlyBudgetCapBdt === null) {
    errors.push('no approved budget boundary — approve a growth brief with monthlyBudgetCapBdt first')
  } else if (projectedMonthlyBdt > context.monthlyBudgetCapBdt) {
    errors.push(
      `projected monthly spend ৳${projectedMonthlyBdt} exceeds the approved cap ৳${context.monthlyBudgetCapBdt} — lower the daily budget or revise the brief`,
    )
  } else if (projectedMonthlyBdt > context.monthlyBudgetCapBdt * 0.8) {
    warnings.push(`projected monthly spend ৳${projectedMonthlyBdt} is >80% of the approved cap ৳${context.monthlyBudgetCapBdt}`)
  }

  if (spec.utm) {
    const v = validateUtm(spec.utm)
    if (!v.ok) errors.push(`utm invalid: ${v.errors.join('; ')}`)
  } else {
    warnings.push('no UTM set — Messenger campaigns tolerate this, but landing-page campaigns must carry UTMs')
  }

  if (!spec.trackingQa?.pixelProven) {
    warnings.push('pixel/CAPI pipeline not proven — results will rely on Meta-reported numbers only (directional)')
  }

  return { ok: errors.length === 0, errors, warnings, projectedMonthlyBdt }
}

/** Deterministic idempotency key — same spec can never create two campaigns. */
export function campaignIdempotencyKey(spec: CampaignPlanSpec): string {
  const identity = JSON.stringify({
    e: spec.experimentId,
    o: spec.objective,
    n: spec.name.trim().toLowerCase(),
    b: spec.dailyBudgetBdt,
    p: spec.page ?? 'lifestyle',
    a: spec.audienceId ?? null,
  })
  return `meta.campaign.idem.${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

/** Owner-readable diff for the point-of-risk approval card. */
export function buildCampaignDiff(spec: CampaignPlanSpec, validation: CampaignValidation): string {
  const lines = [
    `🎯 *নতুন ক্যাম্পেইন (PAUSED তৈরি হবে)* — ${spec.name}`,
    `Experiment: ${spec.experimentId}`,
    `Objective: ${spec.objective} | Page: ${spec.page ?? 'lifestyle'}`,
    `Budget: ৳${roundMoney(spec.dailyBudgetBdt)}/দিন (মাসে ~৳${validation.projectedMonthlyBdt})`,
    `Audience: ${spec.audienceId ? `custom ${spec.audienceId}` : `broad BD, বয়স ${spec.ageMin ?? 18}–${spec.ageMax ?? 45}`}${spec.excludeAudienceId ? ` (exclude ${spec.excludeAudienceId})` : ''}`,
    `Creative: ${spec.headline ? `"${spec.headline}" — ` : ''}${spec.message.slice(0, 100)}${spec.message.length > 100 ? '…' : ''}`,
    `Tracking: ${spec.trackingQa?.pixelProven ? 'pixel proven ✅' : 'pixel unproven ⚠️ (Meta-reported numbers only)'}`,
  ]
  if (validation.warnings.length) lines.push(`⚠️ ${validation.warnings.join(' | ')}`)
  lines.push('', '_Activate করবেন আপনি — তৈরি হয় PAUSED; activation-ই খরচের মুহূর্ত।_')
  return lines.join('\n')
}

/** Claim the idempotency key. False = this spec was already used for a create. */
export async function claimCampaignIdempotency(key: string): Promise<boolean> {
  try {
    await db.agentKvSetting.create({ data: { key, value: JSON.stringify({ claimedAt: new Date().toISOString() }) } })
    return true
  } catch {
    return false // unique violation → already claimed
  }
}

async function changeLog(actionType: string, resourceId: string | null, payload: Record<string, unknown>): Promise<void> {
  try {
    await db.agentAuditLog.create({ data: { actionType, resourceId, payload, actor: 'agent_meta_campaign_graph' } })
  } catch (err) {
    console.warn('[meta-campaign-graph] changelog write failed:', err instanceof Error ? err.message : err)
  }
}

export interface StagedCampaignResult {
  success: boolean
  campaignId?: string
  adSetId?: string
  adId?: string
  deduped?: boolean
  error?: string
}

/**
 * Validate → claim idempotency → create the PAUSED campaign via the proven
 * client → change-log against the experiment. Never activates anything.
 */
export async function stageCampaign(spec: CampaignPlanSpec): Promise<StagedCampaignResult> {
  const brief = await getApprovedBrief('ALMA_LIFESTYLE').catch(() => null)
  const validation = validateCampaignSpec(spec, {
    monthlyBudgetCapBdt: brief?.brief.economics?.monthlyBudgetCapBdt ?? null,
  })
  if (!validation.ok) return { success: false, error: validation.errors.join('; ') }

  const idemKey = campaignIdempotencyKey(spec)
  const claimed = await claimCampaignIdempotency(idemKey)
  if (!claimed) {
    return { success: false, deduped: true, error: 'এই spec-এ ক্যাম্পেইন আগেই তৈরি হয়েছে — duplicate create ব্লক করা হলো (retry-safe)।' }
  }

  const launchSpec: LaunchCampaignSpec = {
    name: spec.name,
    dailyBudgetBdt: spec.dailyBudgetBdt,
    page: spec.page,
    message: spec.message,
    headline: spec.headline,
    imageUrl: spec.imageUrl,
    ageMin: spec.ageMin,
    ageMax: spec.ageMax,
    audienceId: spec.audienceId,
    excludeAudienceId: spec.excludeAudienceId,
  }
  const result = await launchCampaign(launchSpec)

  await changeLog('meta_campaign_stage', result.campaignId ?? null, {
    experimentId: spec.experimentId,
    idemKey,
    spec: { ...spec, message: spec.message.slice(0, 200) },
    result: { success: result.success, campaignId: result.campaignId, error: result.error ?? null },
    pausedByDesign: true,
  })

  if (!result.success) return { success: false, error: result.error }
  return { success: true, campaignId: result.campaignId, adSetId: result.adSetId, adId: result.adId }
}
