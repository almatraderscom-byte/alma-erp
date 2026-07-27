/**
 * S6 — the two moments a campaign genuinely needs Boss.
 *
 * CREDENTIALS. The agent never sees, stores or types a credential. When a fix
 * needs a logged-in surface, it opens the login page in HIS OWN Chrome (the
 * existing live-browser path), raises a card, and parks. He logs in and taps;
 * answering the card resumes the plan.
 *
 * Deliberately NOT `enqueueAgentContinuation`: the unanswered-ask-card block
 * added on 2026-07-25 (an unanswered question must stop the agent talking past
 * him) would otherwise freeze the grind forever. Resuming here flips the plan's
 * own state instead of starting a turn, so the two rules coexist.
 *
 * FAMILY APPROVAL lives in family-approval.ts; this module resolves BOTH card
 * kinds, because the answer arrives through the same ask-card path.
 */
import { prisma } from '@/lib/prisma'
import { setAutodriveState } from '@/agent/lib/planner'
import { loadFindingSet } from '@/agent/lib/grind/finding-set'
import {
  FAMILY_APPROVE_OPTION,
  bindGateCard,
  grantFamily,
  readGateCard,
  revokeFamilyByTarget,
} from '@/agent/lib/grind/family-approval'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const CREDENTIAL_DONE_OPTION = 'লগইন হয়ে গেছে, এগোও'
export const CREDENTIAL_SKIP_OPTION = 'এখন থাক, পরে করব'

/**
 * Ask Boss to log in on a surface the agent cannot (and must not) authenticate
 * to itself. The page is opened in his browser by the caller; this raises the
 * card and parks the plan.
 */
export async function raiseCredentialGate(input: {
  conversationId: string
  setId: string
  planId?: string | null
  what: string
  url?: string
}): Promise<string | null> {
  try {
    const card = await db.agentAskCard.create({
      data: {
        conversationId: input.conversationId,
        question:
          `Boss, এখানে আপনার লগইন লাগবে — ${input.what}` +
          (input.url ? `\n${input.url}` : '') +
          `\n\nআপনি লগইন করে দিলে আমি ঠিক এখান থেকে বাকিটা করে ফেলব। ` +
          `(পাসওয়ার্ড আমি দেখি না, লিখিও না।)`,
        options: JSON.stringify([CREDENTIAL_DONE_OPTION, CREDENTIAL_SKIP_OPTION]),
        status: 'pending',
      },
      select: { id: true },
    })
    await bindGateCard(card.id, {
      kind: 'credential',
      setId: input.setId,
      planId: input.planId ?? null,
    })
    if (input.planId) {
      await setAutodriveState(input.planId, 'blocked', {
        selfCheckNote: `Boss-এর লগইন দরকার: ${input.what}`,
      })
    }
    return card.id as string
  } catch (err) {
    console.warn('[grind] credential gate failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * The plan waiting on this gate starts driving again. Nothing is executed here —
 * the next tick picks the plan up normally, which is what keeps the unanswered-
 * card rule and the grind engine compatible.
 */
export async function resumePlansForGate(planId: string | null | undefined): Promise<void> {
  if (!planId) return
  await setAutodriveState(planId, 'driving', { nextTickAt: new Date() }).catch(() => {})
}

export interface GateResolution {
  handled: boolean
  kind?: 'family_approval' | 'credential'
  granted?: boolean
  planId?: string | null
}

/**
 * Apply an answered card to campaign state. Called (fail-open) from the ask-card
 * answer path, so a tap in the app is all it takes — no extra route, no polling.
 */
export async function resolveGrindGate(cardId: string, option: string): Promise<GateResolution> {
  const binding = await readGateCard(cardId)
  if (!binding) return { handled: false }

  if (binding.kind === 'family_approval') {
    const target = binding.target ?? (await loadFindingSet(binding.setId))?.target ?? ''
    const family = binding.family ?? ''
    const granted = option.trim() === FAMILY_APPROVE_OPTION
    if (target && family) {
      if (granted) await grantFamily(target, family)
      else await revokeFamilyByTarget(target, family)
    }
    // Either way the plan moves: approved → apply mode, rejected → this family
    // is skipped and the campaign carries on with the rest.
    await resumePlansForGate(binding.planId)
    return { handled: true, kind: 'family_approval', granted, planId: binding.planId }
  }

  if (binding.kind === 'credential') {
    const proceed = option.trim() !== 'এখন থাক, পরে করব'
    if (proceed) await resumePlansForGate(binding.planId)
    return { handled: true, kind: 'credential', granted: proceed, planId: binding.planId }
  }

  return { handled: false }
}
