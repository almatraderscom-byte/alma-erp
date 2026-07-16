/**
 * Phase 42 — the versioned Growth Brief ("Growth Brain" memory).
 *
 * One canonical, versioned document per business joining goals, products,
 * margins, stock, offers, customers, competitors, brand rules, channels,
 * budget boundary, target economics, seasonality, current funnel, and risks —
 * with facts, inference, recommendation, and owner decision kept SEPARATE.
 *
 * Rules encoded here (roadmap exit gates):
 * - No campaign/content plan without product availability, margin constraint,
 *   target customer, objective, measurement plan, and an owner-approved
 *   budget boundary → `validateBriefForPlanning` + `getPlanningAuthority`.
 * - Revisions preserve history (new version row; old rows never rewritten)
 *   and must explain why the plan changed (`changeReason` from v2 onward).
 * - Money in the brief is BDT whole-taka.
 */
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** A single statement with provenance — the unit that keeps the brief honest. */
export interface EvidencedStatement {
  text: string
  /** fact = observed data; inference = derived; recommendation = proposed; decision = owner-made. */
  kind: 'fact' | 'inference' | 'recommendation' | 'decision'
  source?: string
  observedAt?: string
}

export interface GrowthBriefContent {
  goals: EvidencedStatement[]
  products: {
    focus: Array<{ sku?: string; name: string; availability: 'in_stock' | 'low' | 'out' | 'unknown'; marginPctOfPrice?: number }>
    notes?: EvidencedStatement[]
  }
  economics: {
    /** Whole-taka BDT. The boundary the owner approved — spend planning must stay inside it. */
    monthlyBudgetCapBdt: number | null
    /** e.g. target CPA / delivered-order profit floor. Whole taka. */
    targetCpaBdt?: number | null
    minGrossMarginPct?: number | null
    notes?: EvidencedStatement[]
  }
  customers: {
    segments: Array<{ name: string; pains?: string[]; objections?: string[]; language?: string }>
    notes?: EvidencedStatement[]
  }
  objective: string | null
  measurementPlan: string | null
  competitors?: EvidencedStatement[]
  brandRules?: string[]
  channels?: string[]
  seasonality?: EvidencedStatement[]
  currentFunnel?: EvidencedStatement[]
  risks?: EvidencedStatement[]
}

export interface GrowthBriefRow {
  id: string
  businessId: string
  version: number
  status: 'draft' | 'approved' | 'superseded' | 'rejected'
  brief: GrowthBriefContent
  changeReason: string | null
  approvedAt: Date | null
  approvedBy: string | null
  createdAt: Date
}

export interface BriefValidation {
  ok: boolean
  missing: string[]
}

/**
 * The planning gate: what an approved brief MUST contain before any
 * campaign/content plan may be generated. Pure — fully unit-tested.
 */
export function validateBriefForPlanning(content: GrowthBriefContent | null | undefined): BriefValidation {
  const missing: string[] = []
  if (!content) return { ok: false, missing: ['brief'] }

  const hasAvailableProduct = (content.products?.focus ?? []).some(
    (p) => p.availability === 'in_stock' || p.availability === 'low',
  )
  if (!hasAvailableProduct) missing.push('product availability (at least one focus product in stock)')

  const hasMarginConstraint =
    (content.products?.focus ?? []).some((p) => typeof p.marginPctOfPrice === 'number') ||
    typeof content.economics?.minGrossMarginPct === 'number' ||
    typeof content.economics?.targetCpaBdt === 'number'
  if (!hasMarginConstraint) missing.push('margin/profit constraint')

  if ((content.customers?.segments ?? []).length === 0) missing.push('target customer segment')
  if (!content.objective?.trim()) missing.push('objective')
  if (!content.measurementPlan?.trim()) missing.push('measurement plan')

  const cap = content.economics?.monthlyBudgetCapBdt
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    missing.push('owner-approved budget boundary (monthlyBudgetCapBdt)')
  }

  return { ok: missing.length === 0, missing }
}

/** Normalize money fields to whole taka; leaves nulls alone. */
export function normalizeBriefMoney(content: GrowthBriefContent): GrowthBriefContent {
  const economics = { ...content.economics }
  if (typeof economics.monthlyBudgetCapBdt === 'number') {
    economics.monthlyBudgetCapBdt = roundMoney(economics.monthlyBudgetCapBdt)
  }
  if (typeof economics.targetCpaBdt === 'number' && economics.targetCpaBdt !== null) {
    economics.targetCpaBdt = roundMoney(economics.targetCpaBdt)
  }
  return { ...content, economics }
}

/** Create the next draft version. From v2 onward a changeReason is mandatory. */
export async function createDraftBrief(opts: {
  businessId?: string
  content: GrowthBriefContent
  changeReason?: string | null
}): Promise<GrowthBriefRow> {
  const businessId = opts.businessId ?? 'ALMA_LIFESTYLE'
  const latest = await db.agentGrowthBrief.findFirst({
    where: { businessId },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  const version = (latest?.version ?? 0) + 1
  if (version > 1 && !opts.changeReason?.trim()) {
    throw new Error('changeReason is required when revising the growth brief (v2+): explain why the plan changed.')
  }
  return db.agentGrowthBrief.create({
    data: {
      businessId,
      version,
      status: 'draft',
      brief: normalizeBriefMoney(opts.content),
      changeReason: opts.changeReason?.trim() || null,
    },
  })
}

/**
 * Owner approval freezes a draft: it becomes the single approved brief;
 * any previously approved version is marked superseded (history preserved).
 */
export async function approveBrief(briefId: string, approvedBy = 'owner'): Promise<GrowthBriefRow> {
  const target = await db.agentGrowthBrief.findUnique({ where: { id: briefId } })
  if (!target) throw new Error(`Growth brief ${briefId} not found`)
  if (target.status === 'approved') return target
  if (target.status !== 'draft') throw new Error(`Growth brief ${briefId} is ${target.status}, not draft`)

  const validation = validateBriefForPlanning(target.brief as GrowthBriefContent)
  if (!validation.ok) {
    throw new Error(`Growth brief incomplete — missing: ${validation.missing.join('; ')}`)
  }

  await db.agentGrowthBrief.updateMany({
    where: { businessId: target.businessId, status: 'approved' },
    data: { status: 'superseded' },
  })
  return db.agentGrowthBrief.update({
    where: { id: briefId },
    data: { status: 'approved', approvedAt: new Date(), approvedBy },
  })
}

export async function getApprovedBrief(businessId = 'ALMA_LIFESTYLE'): Promise<GrowthBriefRow | null> {
  return db.agentGrowthBrief.findFirst({
    where: { businessId, status: 'approved' },
    orderBy: { version: 'desc' },
  })
}

export async function listBriefHistory(businessId = 'ALMA_LIFESTYLE', limit = 20): Promise<GrowthBriefRow[]> {
  return db.agentGrowthBrief.findMany({
    where: { businessId },
    orderBy: { version: 'desc' },
    take: limit,
  })
}

export interface PlanningAuthority {
  allowed: boolean
  brief: GrowthBriefRow | null
  missing: string[]
  /** Bangla message for the owner when planning is blocked. */
  ownerMessage: string | null
}

/**
 * The gate the marketing planner calls before generating any campaign/content
 * plan. Owner-tunable escape hatch: agent_kv_settings key
 * `growth.brief.enforce` = 'false' disables blocking (default: enforce).
 */
export async function getPlanningAuthority(businessId = 'ALMA_LIFESTYLE'): Promise<PlanningAuthority> {
  let enforce = true
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: 'growth.brief.enforce' } })
    if (row?.value?.trim().toLowerCase() === 'false') enforce = false
  } catch {
    /* kv read failure never blocks a decision either way */
  }

  const brief = await getApprovedBrief(businessId).catch(() => null)
  const validation = validateBriefForPlanning(brief?.brief ?? null)

  if (validation.ok) return { allowed: true, brief, missing: [], ownerMessage: null }
  if (!enforce) {
    return {
      allowed: true,
      brief,
      missing: validation.missing,
      ownerMessage: null,
    }
  }
  return {
    allowed: false,
    brief,
    missing: validation.missing,
    ownerMessage:
      brief === null
        ? 'কোনো approved Growth Brief নেই। আগে growth_strategy_run দিয়ে strategy proposal বানিয়ে approve করুন — তারপর marketing plan হবে।'
        : `Growth Brief অসম্পূর্ণ — অনুপস্থিত: ${validation.missing.join('; ')}। Brief revise করে approve করুন।`,
  }
}
