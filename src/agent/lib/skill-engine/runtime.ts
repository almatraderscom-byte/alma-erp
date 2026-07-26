/**
 * Skill Engine V2 — live-turn bridge (Phase B1-integration).
 *
 * Turns the user's message into a ≤3-skill instruction block for the head's volatile
 * prompt. GATED OFF by default (`SKILL_ENGINE_ENABLED` KV/env) so production is
 * unaffected until the owner flips it after a live check. Every path is fail-open to
 * "no skills" — a skill-engine hiccup must never break a turn.
 *
 * On Vercel the SKILL.md packages must be traced into the /api/assistant/chat lambda
 * (see next.config.js outputFileTracingIncludes) — without that, discovery finds
 * nothing on disk and this silently returns '' (safe, but no skills load).
 */
import path from 'path'
import { discoverSkills, selectSkills, activateSkill } from '@/agent/lib/skill-engine/loader'
import { isSkillEngineEnabled } from '@/agent/lib/skill-engine/enabled'
import type { SkillIndex } from '@/agent/lib/skill-engine/types'

const SKILLS_ROOT = path.join(process.cwd(), 'src', 'agent', 'skills')
const MAX_SKILL_BODY_CHARS = 6000 // roadmap: activated SKILL.md ≤ ~5k tokens

export { isSkillEngineEnabled }

// Skills are static files — discover once per process (memoized). A failed scan is
// cached as an empty index so a bad deploy doesn't re-hit the FS every turn.
let cachedIndex: Promise<SkillIndex> | null = null
function getIndex(): Promise<SkillIndex> {
  if (!cachedIndex) {
    cachedIndex = discoverSkills(SKILLS_ROOT).catch(() => ({ skills: [], warnings: ['discover failed'] }))
  }
  return cachedIndex
}

/** Test hook — drop the memoized index (never call in prod). */
export function __resetSkillIndexCache(): void {
  cachedIndex = null
}

/**
 * Build the volatile "active skills" prompt block for this turn, or '' when the
 * engine is off / nothing matches / anything throws.
 */
export interface ActiveSkills {
  block: string
  /** Set only when a conversation pinned one — feeds the `skill_pinned` event. */
  pinned: { skill: string; source: 'owner' | 'router'; layer: string; reason: string } | null
}

/** Thin wrapper for callers that only want the prompt text. */
export async function buildActiveSkillsBlock(
  lastUserText: string,
  opts: { conversationId?: string } = {},
): Promise<string> {
  return (await buildActiveSkills(lastUserText, opts)).block
}

export async function buildActiveSkills(
  lastUserText: string,
  opts: { conversationId?: string } = {},
): Promise<ActiveSkills> {
  const none: ActiveSkills = { block: '', pinned: null }
  if (!(await isSkillEngineEnabled())) return none
  if (!lastUserText || !lastUserText.trim()) return none
  try {
    const index = await getIndex()
    if (index.skills.length === 0) return none

    // SK-3: with a conversation, the skill is PINNED — decided once, announced,
    // and stable for every later turn (one cache write instead of one per turn).
    // Without one (a worker task, a test), fall back to per-call selection.
    let picked = selectSkills(index, lastUserText)
    let pinned: ActiveSkills['pinned'] = null
    if (opts.conversationId) {
      const { resolveSkillPin } = await import('@/agent/lib/skill-engine/pin')
      const pin = await resolveSkillPin(opts.conversationId, lastUserText)
      picked = pin.skill ? index.skills.filter((s) => s.name === pin.skill) : []
      if (pin.skill) {
        pinned = {
          skill: pin.skill,
          source: pin.source === 'owner' ? 'owner' : 'router',
          layer: pin.trace?.layer ?? 'pinned',
          reason: pin.trace?.reason ?? 'আগে থেকেই এই চ্যাটে pin করা',
        }
      }
    }
    if (picked.length === 0) return none

    const bodies: string[] = []
    for (const meta of picked) {
      const activated = await activateSkill(meta)
      if (!activated) continue
      const body = activated.instructions.slice(0, MAX_SKILL_BODY_CHARS)
      bodies.push(`### ${activated.manifest.name} (v${activated.manifest.version})\n${body}`)
    }
    if (bodies.length === 0) return none

    // The owner asked to be TOLD which skill is running, before the work starts.
    const announce = pinned
      ? `\nপ্রথম লাইনেই Boss-কে বলো: \`${pinned.skill}\` skill ব্যবহার করছি।\n`
      : ''

    const block = (
      `\n## সক্রিয় Skill (এই কাজের procedure)\n` +
      `এই কাজের জন্য নিচের skill-এর ধাপ + guardrail হুবহু অনুসরণ করো (freestyle নয়); ` +
      `শুধু উল্লিখিত Alma tool ব্যবহার করবে, skill নিজে কোনো ক্ষমতা দেয় না — অনুমোদন/টাকা/publish আগের মতোই gated।\n` +
      announce +
      `\n` +
      bodies.join('\n\n')
    )
    return { block, pinned }
  } catch {
    return none
  }
}
