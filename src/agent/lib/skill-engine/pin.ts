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
import { applyRules, routeSkill, type RouteDecision } from '@/agent/lib/skill-engine/router'
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

/**
 * A router pin may span short follow-ups, but it must not hide the tools for an
 * explicit new business-data job.  This is deliberately narrower than running
 * the keyword router on every message: acknowledgements such as "ha koro" keep
 * the cached skill, while a staff-dispatch chat that moves to orders/approvals
 * releases the allowlist that would otherwise make the request impossible.
 * Owner pins remain sticky and never pass through this gate.
 */
export function shouldReleaseRouterPin(pinnedSkill: string, text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false

  const staleNarrowPins = new Set([
    'alma-staff-dispatch',
    'alma-agent-incident-diagnosis',
  ])

  if (staleNarrowPins.has(pinnedSkill)) {
    const explicitErpScope =
      /(orders?|অর্ডার|approval|অনুমোদন|revenue|sales?|বিক্রি|stock|inventory|product|customer|pending\s+approval)/i
    return explicitErpScope.test(t)
  }

  return false
}

/**
 * Plain ERP record reads belong to the general agent toolset, not to a narrow
 * workflow skill.  Without this guard a released incident pin was selected
 * again on the very next identical order query because words such as "status"
 * scored against incident-diagnosis.  Keep this intentionally read-shaped so
 * genuine diagnostic requests ("why are orders failing?") can still route.
 */
export function isExplicitErpRecordRead(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false

  const record =
    /(orders?|অর্ডার|approval|অনুমোদন|revenue|sales?|বিক্রি|stock|inventory|product|customer|pending\s+approval)/i
  const readIntent =
    /(show|list|read|fetch|get|latest|newest|recent|দেখাও|দেখান|লিস্ট|তালিকা|সর্বশেষ|নতুন|কত|status|স্ট্যাটাস|id\b)/i
  const diagnosticIntent =
    /(why|কেন|issue|সমস্যা|error|fail(?:ed|ing|ure)?|broken|health\s*scan|diagnos|root\s*cause)/i

  return record.test(t) && readIntent.test(t) && !diagnosticIntent.test(t)
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
      const source = stored?.source === 'owner' ? 'owner' : 'router'

      // THE JOB CAN CHANGE INSIDE ONE CHAT (found live 2026-07-27). He audits the
      // site, reads the result, then says "ekhon thik koro" — same conversation,
      // different job. With the pin frozen for the whole chat, that fix order
      // stayed under `seo-auditing-own-site`, whose allowlist holds no write
      // tool: the agent announced "draft_seo_fixes চালিয়ে batch ready করছি" and
      // could not possibly do it. "One chat, one job" was the wrong half of the
      // rule to keep rigid.
      //
      // Only the RULE layer may re-pin. Rules are the deterministic cases —
      // "ঠিক করো" is a fix, "অডিট করো" is an audit — the ones SK-3 deliberately
      // never sends to a model. Keyword drift must NOT move a pin: that would
      // re-pick every turn and destroy the cached prefix the pin exists to
      // protect. And an OWNER pin is never overridden by anything.
      const rule = source === 'owner' ? null : applyRules(lastUserText)
      if (rule && rule.skill !== conv.pinnedSkill) {
        const decision: RouteDecision = {
          skill: rule.skill,
          layer: 'rule',
          reason: `${rule.id}: ${rule.why} — কাজ বদলেছে, তাই skill বদলালাম`,
          candidates: [{ name: rule.skill, score: Infinity }],
          needsModel: false,
        }
        await writePin(conversationId, rule.skill, decision, 'router')
        return { skill: rule.skill, source: 'router', trace: decision }
      }

      if (source === 'router' && shouldReleaseRouterPin(conv.pinnedSkill, lastUserText)) {
        const decision: RouteDecision = {
          skill: null,
          layer: 'rule',
          reason: `scope-exit: ${conv.pinnedSkill} এই নতুন ERP/data কাজের tool scope ঢেকে দিচ্ছিল — pin সরালাম`,
          candidates: [],
          needsModel: false,
        }
        await db.agentConversation.update({
          where: { id: conversationId },
          data: { pinnedSkill: null, skillRouteTrace: null },
        })
        return { skill: null, source: 'none', trace: decision }
      }

      return { skill: conv.pinnedSkill, source, trace: null }
    }

    const index = await discoverSkills(SKILLS_ROOT, { includeDraft: opts.includeDraft })
    if (index.skills.length === 0) return { skill: null, source: 'none', trace: null }

    if (isExplicitErpRecordRead(lastUserText)) {
      const decision: RouteDecision = {
        skill: null,
        layer: 'rule',
        reason: 'erp-record-read: সাধারণ ERP read tools ব্যবহার হবে; narrow workflow skill pin করা হবে না',
        candidates: [],
        needsModel: false,
      }
      return { skill: null, source: 'none', trace: decision }
    }

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
