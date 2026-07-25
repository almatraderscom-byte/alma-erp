/**
 * The conversation an autonomously-driven plan runs in.
 *
 * Two S0 problems, one fix:
 *
 *  1. Both self-feeders (`promote.ts`, `signal-scan.ts`) created plans with NO
 *     conversationId. `executor.ts` hard-fails such a plan ("plan has no
 *     conversationId — cannot run a head turn"), so the entire proactive-autonomy
 *     layer could never execute a single step — it produced plans that were dead
 *     on arrival.
 *
 *  2. A step turn persists its directive as a user message. Running a ~79-step
 *     grind campaign inside Boss's own chat would bury it under synthetic
 *     machine messages.
 *
 * So each driven plan gets its OWN conversation: the head keeps full context for
 * that plan, the audit trail is complete, and Boss's chat stays his. The link is
 * a KV row (no migration), and the conversation is created lazily — a plan the
 * owner started in his chat keeps that chat.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DRIVE_CONV_PREFIX = 'plan_drive_conversation:'

const driveConvKey = (planId: string) => `${DRIVE_CONV_PREFIX}${planId}`

/** The drive conversation for a plan, if one was already created. */
export async function getDriveConversationId(planId: string): Promise<string | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: driveConvKey(planId) } })
  const id = row?.value?.trim()
  if (!id) return null
  const conv = await db.agentConversation.findUnique({ where: { id }, select: { id: true } })
  return conv?.id ?? null
}

/**
 * Ensure the plan has a conversation to run steps in. Returns the plan's own
 * conversation when it has one (owner-started plans), otherwise creates/reuses a
 * dedicated drive conversation and attaches it to the plan row.
 */
export async function ensureDriveConversation(plan: {
  id: string
  goal: string
  businessId?: string | null
  conversationId?: string | null
}): Promise<string> {
  if (plan.conversationId) return plan.conversationId

  const existing = await getDriveConversationId(plan.id)
  if (existing) {
    await db.agentPlan.update({ where: { id: plan.id }, data: { conversationId: existing } }).catch(() => {})
    return existing
  }

  const conv: { id: string } = await db.agentConversation.create({
    data: {
      title: `স্বয়ংক্রিয় কাজ — ${plan.goal.slice(0, 60)}`,
      source: 'plan_drive',
      businessId: plan.businessId ?? 'ALMA_LIFESTYLE',
    },
    select: { id: true },
  })

  await prisma.agentKvSetting.upsert({
    where: { key: driveConvKey(plan.id) },
    update: { value: conv.id },
    create: { key: driveConvKey(plan.id), value: conv.id },
  })
  await db.agentPlan.update({ where: { id: plan.id }, data: { conversationId: conv.id } }).catch(() => {})

  return conv.id
}
