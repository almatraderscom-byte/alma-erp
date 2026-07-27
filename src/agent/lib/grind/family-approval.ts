/**
 * S6 — family approval. Boss's rule, exactly as he stated it: "approve the first
 * batch, then let it run."
 *
 * A family with no grant runs in PROPOSAL mode: the agent produces the precise
 * before/after for that batch and applies NOTHING. That proposal becomes one
 * card. When Boss approves, the batch re-runs in APPLY mode and every later batch
 * of that family runs unattended.
 *
 * Grants are scoped per family AND per target site. Approving "rewrite thin
 * product copy" for almatraders.com must never authorise the same edit on
 * another site — a grant is permission for a specific change on a specific
 * property, not a personality trait.
 */
import { prisma } from '@/lib/prisma'
import { loadFindingSet } from '@/agent/lib/grind/finding-set'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type FamilyMode = 'proposal' | 'apply'

const GRANT_PREFIX = 'grind_family_grant:'
const CARD_PREFIX = 'grind_gate_card:'

const grantKey = (target: string, family: string) => `${GRANT_PREFIX}${target}|${family}`

export interface GateCardBinding {
  kind: 'family_approval' | 'credential'
  setId: string
  planId?: string | null
  family?: string
  target?: string
}

/** May this family apply changes unattended on this site? */
export async function getFamilyMode(target: string, family: string): Promise<FamilyMode> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: grantKey(target, family) } })
  return row?.value === 'granted' ? 'apply' : 'proposal'
}

export async function grantFamily(target: string, family: string): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: grantKey(target, family) },
    update: { value: 'granted' },
    create: { key: grantKey(target, family), value: 'granted' },
  })
}

export async function revokeFamilyByTarget(target: string, family: string): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: grantKey(target, family) },
    update: { value: 'revoked' },
    create: { key: grantKey(target, family), value: 'revoked' },
  })
}

/**
 * Take the grant away — used when a family regressed twice. Back to proposal
 * mode: it may still work, but Boss looks at the next batch first.
 */
export async function revokeFamilyGrant(setId: string, family: string): Promise<void> {
  const set = await loadFindingSet(setId)
  if (!set) return
  await revokeFamilyByTarget(set.target, family)
}

/** "এই family আর জিজ্ঞেস কোরো না" / "এই family থামাও" — the panel's two buttons. */
export async function setFamilyGrant(target: string, family: string, granted: boolean): Promise<void> {
  if (granted) await grantFamily(target, family)
  else await revokeFamilyByTarget(target, family)
}

// ── Cards ───────────────────────────────────────────────────────────────────

export const FAMILY_APPROVE_OPTION = 'হ্যাঁ, এভাবেই বাকিগুলোও করো'
export const FAMILY_REJECT_OPTION = 'না, এভাবে কোরো না'

/**
 * Ask Boss to approve the first batch of a family. The card carries the actual
 * proposal text the agent produced — he approves a concrete change, not an
 * abstract permission.
 */
export async function raiseFamilyApprovalCard(input: {
  conversationId: string
  setId: string
  planId?: string | null
  target: string
  family: string
  proposal: string
}): Promise<string | null> {
  try {
    const card = await db.agentAskCard.create({
      data: {
        conversationId: input.conversationId,
        question:
          `Boss, "${input.family}" ধরনের সমস্যাগুলো এভাবে ঠিক করতে চাই — প্রথম ব্যাচের প্রস্তাব:\n\n` +
          `${input.proposal.slice(0, 1500)}\n\n` +
          `এটা ঠিক থাকলে বাকিগুলোও একইভাবে নিজে থেকে করে ফেলব।`,
        options: JSON.stringify([FAMILY_APPROVE_OPTION, FAMILY_REJECT_OPTION]),
        status: 'pending',
      },
      select: { id: true },
    })
    await bindGateCard(card.id, {
      kind: 'family_approval',
      setId: input.setId,
      planId: input.planId ?? null,
      family: input.family,
      target: input.target,
    })
    return card.id as string
  } catch (err) {
    console.warn('[grind] family approval card failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export async function bindGateCard(cardId: string, binding: GateCardBinding): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: `${CARD_PREFIX}${cardId}` },
    update: { value: JSON.stringify(binding) },
    create: { key: `${CARD_PREFIX}${cardId}`, value: JSON.stringify(binding) },
  })
}

export async function readGateCard(cardId: string): Promise<GateCardBinding | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: `${CARD_PREFIX}${cardId}` } })
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as GateCardBinding
    return parsed && typeof parsed.setId === 'string' ? parsed : null
  } catch {
    return null
  }
}
