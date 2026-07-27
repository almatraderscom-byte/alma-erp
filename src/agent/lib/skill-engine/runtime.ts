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
import { isIsolatedSkill, type IsolatedSkillPrompt } from '@/agent/lib/skill-engine/isolation'
import { skillIsolationEnabled } from '@/agent/config'
import type { SkillIndex, SkillManifest } from '@/agent/lib/skill-engine/types'

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
  /** SK-4: the pinned skill's manifest — allowlist, dependencies, done gate. */
  manifest: SkillManifest | null
  /**
   * SK-7. Set ONLY when the pinned skill declares `isolation: subagent` and the
   * flag is on — the skill's own system prompt, to REPLACE the behavioural
   * prompt rather than ride in its volatile tail (skill-engine/isolation.ts).
   *
   * `block` stays populated alongside it on purpose: a caller that does not know
   * about isolation (core.ts's native path, tests) keeps the exact inline
   * behaviour it has today. The caller that DOES support it drops `block` and
   * uses this instead — never both, or the procedure would ship twice.
   */
  isolated: IsolatedSkillPrompt | null
  /**
   * SK-8 — the skill matched, and the provenance gate refused to run it.
   *
   * Two sessions found this on the same day, from opposite ends, and both
   * findings are worth keeping.
   *
   * From the live REVOKE test: the reason started as a sentence in the prompt
   * asking the head to explain itself. The skill correctly did not run and the
   * head said nothing at all — it answered as though nothing had matched. A
   * prompt rule is a request.
   *
   * From production: `seo-fixing-own-site` was approved at one content hash, its
   * files were edited the next day (#627), and the gate correctly read that as
   * `changed` — correct, and SILENT. From the outside the engine looked switched
   * on and idle. A refusal nobody can see is indistinguishable from a bug.
   *
   * So the reason goes on the wire as its own event and the UI draws it, the
   * same way the pin announcement had to stop being a prompt instruction.
   */
  heldBack: { skill: string; state: string; reason: string } | null
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
  const none: ActiveSkills = { block: '', pinned: null, manifest: null, isolated: null, heldBack: null }
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

    // SK-8 — provenance. Which version is this, who approved it, and is it still
    // approved? With the gate OFF this only observes and logs, so the ledger can
    // be filled from real traffic before it starts refusing anything; with it ON
    // an unapproved, edited or revoked skill does not run at all.
    let heldBack: { skill: string; state: string } | null = null
    try {
      const [{ loadApprovalLedger }, { approvalStateWithBase, mayRun }, { skillApprovalGateEnabled }] =
        await Promise.all([
          import('@/agent/lib/skill-engine/approval-store'),
          import('@/agent/lib/skill-engine/provenance'),
          import('@/agent/config'),
        ])
      const ledger = await loadApprovalLedger()
      const gateOn = skillApprovalGateEnabled()
      const allowed = picked.filter((meta) => {
        // A skill is only as approved as the base it inherits. `alma-base` is
        // never SELECTED, so checking the picked skill alone left the ALMA
        // invariants outside provenance entirely.
        const baseMeta = meta.extends
          ? index.skills.find((s) => s.name === meta.extends) ?? null
          : null
        const { state, blockedBy } = approvalStateWithBase(
          { name: meta.name, version: meta.version, hash: meta.hash },
          baseMeta ? { name: baseMeta.name, version: baseMeta.version, hash: baseMeta.hash } : null,
          ledger,
        )
        if (state !== 'approved') {
          console.info('[skill-provenance]', { skill: meta.name, version: meta.version, state, blockedBy, gateOn })
        }
        if (mayRun(state, gateOn)) return true
        heldBack = { skill: blockedBy, state }
        return false
      })
      if (allowed.length === 0 && heldBack) {
        // Say WHY rather than behaving as if no skill matched — a skill silently
        // withheld is the same failure shape as the silent continuation.
        const { heldBackReason } = await import('@/agent/lib/skill-engine/provenance')
        const h = heldBack as { skill: string; state: string }
        const reason = heldBackReason(h.skill, h.state as never)
        // Structured, not just prose: the client draws the refusal from this,
        // and the owner learns his skill is waiting on him instead of guessing.
        return {
          ...none,
          block: `\n## Skill\n${reason}\n`,
          heldBack: { skill: h.skill, state: h.state, reason },
        }
      }
      picked = allowed
    } catch {
      /* provenance must never break a turn — fall through with the picked set */
    }

    const bodies: string[] = []
    let manifest: SkillManifest | null = null
    // SK-7: the FIRST activated skill is the one that can isolate. Isolation is
    // a one-skill decision by construction — a lean prompt built from two
    // competing skills would not be lean or coherent.
    let primary: Awaited<ReturnType<typeof activateSkill>> = null
    for (const meta of picked) {
      const activated = await activateSkill(meta)
      if (!activated) continue
      primary = primary ?? activated
      manifest = manifest ?? activated.manifest
      const body = activated.instructions.slice(0, MAX_SKILL_BODY_CHARS)
      bodies.push(`### ${activated.manifest.name} (v${activated.manifest.version})\n${body}`)
    }
    if (bodies.length === 0) return none

    // The owner asked to be TOLD which skill is running, before the work starts.
    // Owner correction 2026-07-26: my first attempt told the head to write the
    // skill name as its own first line, which collided with the speak-first rule
    // — and then my "fix" forbade an extra line, which was a restriction he never
    // asked for. His point stands: the opening line can hold the address, the
    // skill and the understanding at once. Nothing about those three conflicts.
    //
    // So this ADDS an ingredient; it does not constrain the shape. The guaranteed
    // announcement is the system line the UI draws from `skill_pinned` — this only
    // lets the agent's own words match it.
    const announce = pinned
      ? `\nএই কাজটা \`${pinned.skill}\` skill ধরে করছ — Boss-কে সেটা জানিয়ে দাও। `
        + `তোমার শুরুর লাইনেই সম্বোধন, skill-এর নাম আর কী বুঝেছ — তিনটাই একসাথে বলা যায়, `
        + `যেমন: "বস, ৪২টা প্রোডাক্টের meta ঠিক করতে বলছেন — \`${pinned.skill}\` skill ধরে শুরু করছি।"\n`
      : ''

    const block = (
      `\n## সক্রিয় Skill (এই কাজের procedure)\n` +
      `এই কাজের জন্য নিচের skill-এর ধাপ + guardrail হুবহু অনুসরণ করো (freestyle নয়); ` +
      `শুধু উল্লিখিত Alma tool ব্যবহার করবে, skill নিজে কোনো ক্ষমতা দেয় না — অনুমোদন/টাকা/publish আগের মতোই gated।\n` +
      announce +
      `\n` +
      bodies.join('\n\n')
    )

    // SK-7 — isolation needs BOTH: the skill asked for it, and the flag allows
    // it. Only a pinned skill can isolate: without a pin the selection can shift
    // mid-conversation, and swapping the whole system prompt between turns would
    // rewrite the cached prefix every message (the cost failure the pin exists
    // to prevent). Anything missing → the normal inline block, unchanged.
    const isolated: IsolatedSkillPrompt | null =
      primary && pinned && isIsolatedSkill(primary.manifest) && skillIsolationEnabled()
        ? {
            skillName: primary.manifest.name,
            baseInstructions: primary.baseInstructions,
            systemPrompt: primary.systemPrompt,
            instructions: primary.instructions.slice(0, MAX_SKILL_BODY_CHARS),
            announce,
          }
        : null

    return { block, pinned, manifest, isolated, heldBack: null }
  } catch {
    return none
  }
}
