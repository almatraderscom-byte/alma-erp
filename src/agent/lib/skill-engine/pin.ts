/**
 * SK-3 — pinning a skill to a conversation.
 *
 * One chat, one job. Two reasons this is a pin and not a per-turn decision:
 *
 *  - Cost. A skill body is ~5k tokens in the system prompt. Re-selecting a
 *    DIFFERENT one each turn changes the cached prefix every turn, and the
 *    owner's own meter already showed what that costs (~$0.17/turn before the
 *    history work). Pinned, it is one cache write for the whole conversation.
 *  - Truth. The owner asked to SEE which skill is running. A value that changes
 *    silently between turns is not something anyone can see.
 *
 * The pin is set once, announced, and overridable by the owner at any time. An
 * owner override always wins and is never re-decided by the router afterwards.
 */
import { prisma } from '@/lib/prisma'
import { discoverSkills } from '@/agent/lib/skill-engine/loader'
import { routeSkill, type RouteDecision } from '@/agent/lib/skill-engine/router'
import path from 'path'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')

export interface SkillPin {
  skill: string | null
  /** How it got here — 'owner' can never be overwritten by the router. */
  source: 'owner' | 'router' | 'none'
  trace: RouteDecision | null
}

export interface StoredTrace {
  layer: string
  reason: string
  candidates: Array<{ name: string; score: number }>
  source: 'owner' | 'router'
  at: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/**
 * Resolve the pin for this turn. Returns the existing pin untouched when one is
 * set — the router runs only on a conversation that has none yet.
 *
 * Fail-open by design: any error returns "no skill", because a skill-engine
 * hiccup must never break a turn.
 */
export async function resolveSkillPin(
  conversationId: string,
  lastUserText: string,
  opts: { includeDraft?: boolean } = {},
): Promise<SkillPin> {
  try {
    const conv = await db.agentConversation.findUnique({
      where: { id: conversationId },
      select: { pinnedSkill: true, skillRouteTrace: true },
    })

    if (conv?.pinnedSkill) {
      const stored = conv.skillRouteTrace as StoredTrace | null
      return {
        skill: conv.pinnedSkill,
        source: stored?.source === 'owner' ? 'owner' : 'router',
        trace: null,
      }
    }

    const index = await discoverSkills(SKILLS_ROOT, { includeDraft: opts.includeDraft })
    if (index.skills.length === 0) return { skill: null, source: 'none', trace: null }

    const decision = routeSkill(index, lastUserText)
    if (!decision.skill) return { skill: null, source: 'none', trace: decision }

    await writePin(conversationId, decision.skill, decision, 'router')
    return { skill: decision.skill, source: 'router', trace: decision }
  } catch {
    return { skill: null, source: 'none', trace: null }
  }
}

/** The owner's choice — sticky, and the router never revisits it. */
export async function setOwnerPin(conversationId: string, skill: string | null): Promise<void> {
  if (!skill) {
    await db.agentConversation.update({
      where: { id: conversationId },
      data: { pinnedSkill: null, skillRouteTrace: null },
    })
    return
  }
  await writePin(conversationId, skill, null, 'owner')
}

async function writePin(
  conversationId: string,
  skill: string,
  decision: RouteDecision | null,
  source: 'owner' | 'router',
): Promise<void> {
  const trace: StoredTrace = {
    layer: decision?.layer ?? 'owner',
    reason: decision?.reason ?? 'Boss নিজে বেছে দিয়েছেন',
    candidates: decision?.candidates ?? [],
    source,
    at: new Date().toISOString(),
  }
  await db.agentConversation.update({
    where: { id: conversationId },
    data: { pinnedSkill: skill, skillRouteTrace: trace },
  })
}

/**
 * The one line the head must open with. The owner asked to be told which skill
 * is in use before the work starts — this is that sentence, and the announcement
 * check later verifies it was said.
 */
export function announcementLine(skill: string): string {
  return `\`${skill}\` skill ব্যবহার করছি।`
}

/** Did the reply actually announce the pinned skill? */
export function announcedSkill(replyText: string, skill: string): boolean {
  if (!skill) return true
  return replyText.toLowerCase().includes(skill.toLowerCase())
}
