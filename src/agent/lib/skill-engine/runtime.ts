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
export async function buildActiveSkillsBlock(lastUserText: string): Promise<string> {
  if (!(await isSkillEngineEnabled())) return ''
  if (!lastUserText || !lastUserText.trim()) return ''
  try {
    const index = await getIndex()
    if (index.skills.length === 0) return ''
    const picked = selectSkills(index, lastUserText)
    if (picked.length === 0) return ''

    const bodies: string[] = []
    for (const meta of picked) {
      const activated = await activateSkill(meta)
      if (!activated) continue
      const body = activated.instructions.slice(0, MAX_SKILL_BODY_CHARS)
      bodies.push(`### ${activated.manifest.name} (v${activated.manifest.version})\n${body}`)
    }
    if (bodies.length === 0) return ''

    return (
      `\n## সক্রিয় Skill (এই কাজের procedure)\n` +
      `এই কাজের জন্য নিচের skill-এর ধাপ + guardrail হুবহু অনুসরণ করো (freestyle নয়); ` +
      `শুধু উল্লিখিত Alma tool ব্যবহার করবে, skill নিজে কোনো ক্ষমতা দেয় না — অনুমোদন/টাকা/publish আগের মতোই gated।\n\n` +
      bodies.join('\n\n')
    )
  } catch {
    return ''
  }
}
