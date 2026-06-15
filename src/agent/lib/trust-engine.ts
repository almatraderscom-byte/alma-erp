import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type TrustTier = 'auto' | 'notify' | 'approve'

export interface TrustDecision {
  tier: TrustTier
  ruleId: string | null
  reason: string
}

const ALWAYS_APPROVE = new Set([
  'auto_fix',
  'fb_post',
  'website_publish',
  'campaign_create',
])

const FINANCIAL_APPROVE_THRESHOLD = 500

export async function getTrustDecision(
  domain: string,
  actionPattern: string,
  businessId: string = 'ALMA_LIFESTYLE',
  costEstimate?: number,
): Promise<TrustDecision> {
  if (ALWAYS_APPROVE.has(actionPattern)) {
    return { tier: 'approve', ruleId: null, reason: 'high-risk action always requires approval' }
  }

  if (costEstimate && costEstimate > FINANCIAL_APPROVE_THRESHOLD) {
    return { tier: 'approve', ruleId: null, reason: `cost ৳${costEstimate} exceeds threshold` }
  }

  try {
    const rule = await db.agentTrustRule.findUnique({
      where: { domain_actionPattern_businessId: { domain, actionPattern, businessId } },
    })

    if (!rule) {
      return { tier: 'approve', ruleId: null, reason: 'no trust rule — default approve' }
    }

    return { tier: rule.tier as TrustTier, ruleId: rule.id, reason: `trust rule: ${rule.consecutiveApprovals} consecutive approvals` }
  } catch {
    return { tier: 'approve', ruleId: null, reason: 'trust engine error — fallback approve' }
  }
}

export async function recordApproval(
  domain: string,
  actionPattern: string,
  businessId: string = 'ALMA_LIFESTYLE',
): Promise<{ promoted: boolean; newTier?: TrustTier }> {
  try {
    const rule = await db.agentTrustRule.upsert({
      where: { domain_actionPattern_businessId: { domain, actionPattern, businessId } },
      create: { domain, actionPattern, businessId, tier: 'approve', approvalCount: 1, consecutiveApprovals: 1 },
      update: { approvalCount: { increment: 1 }, consecutiveApprovals: { increment: 1 }, rejectionCount: 0 },
    })

    if (rule.tier === 'approve' && rule.consecutiveApprovals >= 5) {
      await db.agentTrustRule.update({
        where: { id: rule.id },
        data: { tier: 'notify', lastPromotedAt: new Date() },
      })
      return { promoted: true, newTier: 'notify' }
    }

    if (rule.tier === 'notify' && rule.consecutiveApprovals >= 15) {
      await db.agentTrustRule.update({
        where: { id: rule.id },
        data: { tier: 'auto', lastPromotedAt: new Date() },
      })
      return { promoted: true, newTier: 'auto' }
    }

    return { promoted: false }
  } catch {
    return { promoted: false }
  }
}

export async function recordRejection(
  domain: string,
  actionPattern: string,
  businessId: string = 'ALMA_LIFESTYLE',
): Promise<void> {
  try {
    await db.agentTrustRule.upsert({
      where: { domain_actionPattern_businessId: { domain, actionPattern, businessId } },
      create: { domain, actionPattern, businessId, tier: 'approve', rejectionCount: 1 },
      update: {
        rejectionCount: { increment: 1 },
        consecutiveApprovals: 0,
        tier: 'approve',
      },
    })
  } catch { /* non-fatal */ }
}

export async function getAllTrustRules(businessId?: string) {
  try {
    const where = businessId ? { businessId } : {}
    return await db.agentTrustRule.findMany({
      where,
      orderBy: [{ domain: 'asc' }, { actionPattern: 'asc' }],
    })
  } catch {
    return []
  }
}

/**
 * Seeds known-safe trust rules. Called once on first load.
 * Low-risk staff operations start at 'auto' or 'notify'.
 */
export async function seedDefaultTrustRules(businessId: string = 'ALMA_LIFESTYLE'): Promise<number> {
  const defaults: Array<{ domain: string; actionPattern: string; tier: TrustTier }> = [
    // These are low-risk, no customer impact — safe to auto-send
    { domain: 'staff', actionPattern: 'staff_auto_message:presence', tier: 'auto' },
    { domain: 'staff', actionPattern: 'staff_auto_message:coaching', tier: 'auto' },
    { domain: 'staff', actionPattern: 'staff_auto_message:reminder', tier: 'auto' },
    { domain: 'staff', actionPattern: 'staff_auto_message:feedback_ack', tier: 'auto' },
    { domain: 'staff', actionPattern: 'staff_auto_message:proof_reminder', tier: 'auto' },

    // These affect staff work but are routine — notify owner
    { domain: 'staff', actionPattern: 'staff_auto_message:task_dispatch', tier: 'notify' },
    { domain: 'staff', actionPattern: 'staff_auto_message:announcement', tier: 'notify' },
    { domain: 'staff', actionPattern: 'staff_auto_message:task_redo', tier: 'notify' },
  ]

  let seeded = 0
  for (const rule of defaults) {
    try {
      await db.agentTrustRule.upsert({
        where: { domain_actionPattern_businessId: { domain: rule.domain, actionPattern: rule.actionPattern, businessId } },
        create: { ...rule, businessId, approvalCount: 10, consecutiveApprovals: 10 },
        update: {}, // Don't overwrite if already exists
      })
      seeded++
    } catch { /* ignore duplicates */ }
  }
  return seeded
}

export async function setTrustTier(
  ruleId: string,
  tier: TrustTier,
): Promise<boolean> {
  try {
    await db.agentTrustRule.update({
      where: { id: ruleId },
      data: { tier, lastPromotedAt: new Date(), consecutiveApprovals: 0 },
    })
    return true
  } catch {
    return false
  }
}
