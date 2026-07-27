/**
 * SK-7 — `isolation: subagent`, the half of the owner's ask that was still missing.
 *
 * His brief, 2026-07-26: *"প্রতিটি Skill-এর নিজস্ব System Prompt, Rules, Constraints
 * এবং Execution Logic থাকবে … অন্য কোনো অপ্রয়োজনীয় নিয়ম বা আচরণ সেখানে প্রভাব ফেলবে না।"*
 *
 * Until now a pinned skill was APPENDED to the volatile tail of a ~30-module
 * behavioural prompt (system-prompt.ts: `volatileParts.push(activeSkillsBlock)`),
 * so every unrelated rule rode along — the exact opposite of what he asked for.
 * `SYSTEM.md` had existed on disk since SK-5 and no code ever opened it.
 *
 * ── What "isolation" is, and what it deliberately is NOT ────────────────────
 *
 * The design doc said route the job through `runSubAgent`. Read literally that
 * costs him more than it buys: that runner is capped at 4 tool iterations and
 * 2048 output tokens, does not stream, and returns a 3–6 line summary string
 * (subagent.ts). The SEO batch job needs 5–7 tool rounds, and he asked to WATCH
 * the agent think. So isolation here is delivered inside the streaming owner
 * turn, and it means exactly the two things that carry the guarantee:
 *
 *   1. its own system prompt   — this module
 *   2. its own tool list       — `filterToolsForSkill` (SK-4, already live)
 *
 * ── Why a kernel survives, rather than "skill only" ─────────────────────────
 *
 * §6 of the plan draws the line: skills own TASK knowledge; global code keeps
 * what the agent IS. That is already marked in the prompt registry as
 * `core: true` and compiled by `compileStableCore()` — identity, honesty/claim
 * verification, response style, delivery defaults, task completion, planning.
 * Dropping those would not be isolation, it would be a different agent. What
 * DOES go is the ~25 business-domain modules (operations, staff care, channel
 * rules, counter-proposal, marketing…) that have nothing to do with the job.
 *
 * And the gates never live in prose anyway — approvals, money and publish are
 * server-side code, so no prompt swap can talk past them (§3b authority ladder).
 *
 * Pure module: no I/O, no registry import. The kernel text is injected so this
 * stays unit-testable without dragging in the 170 KB prompt module.
 */
import type { SkillManifest } from '@/agent/lib/skill-engine/types'

/** Does this skill run in its own lean prompt? Absent/`inline` = the old path. */
export function isIsolatedSkill(manifest: Pick<SkillManifest, 'isolation'> | null | undefined): boolean {
  return manifest?.isolation === 'subagent'
}

export interface IsolatedSkillPrompt {
  skillName: string
  /** `alma-base/SKILL.md` — the ALMA invariants, resolved from `extends:`. */
  baseInstructions: string
  /** The skill's own `SYSTEM.md`. */
  systemPrompt: string
  /** The skill's `SKILL.md` procedure body. */
  instructions: string
  /** The "tell Boss which skill is running" line, unchanged from the inline path. */
  announce?: string
}

const HEADER =
  '\n## এই কাজের জন্য তোমার নিজস্ব নির্দেশনা (isolated skill run)\n' +
  'এই চ্যাটে `{skill}` skill pin করা আছে, আর এই কাজের নিয়ম নিচেই সম্পূর্ণ — ' +
  'ব্যবসার অন্য কোনো domain নিয়ম এই turn-এ আসেনি, কারণ সেগুলো এই কাজের সাথে সম্পর্কিত নয়। ' +
  'নিচের ধাপ আর guardrail হুবহু অনুসরণ করো, freestyle নয়।\n' +
  'উপরের কাঠামোগত নিয়ম (সততা, উত্তরের ধরন, কাজ শেষ করার নিয়ম) সবসময়ের মতোই বহাল। ' +
  'অনুমোদন, টাকা আর publish-এর গেট কোডে বসানো — skill সেগুলোর উপরে নয়, ' +
  'আর skill নিজে কোনো ক্ষমতা দেয় না: এই turn-এ যে tool গুলো দেওয়া হয়েছে, সেগুলোই তোমার সবটা।\n'

/**
 * The isolated stable prompt: kernel → ALMA invariants → the skill's own system
 * prompt → the skill's procedure. Deterministic order, because it becomes the
 * CACHED prefix — the skill is pinned per conversation, so this is one cache
 * write for the whole job instead of a volatile block re-billed every turn.
 */
export function buildIsolatedSystemPrompt(
  kernel: string,
  skill: IsolatedSkillPrompt,
): string {
  const parts = [kernel.trim(), HEADER.replace('{skill}', skill.skillName)]
  if (skill.baseInstructions.trim()) {
    parts.push(`\n### ALMA-র সাধারণ নিয়ম (alma-base)\n${skill.baseInstructions.trim()}`)
  }
  if (skill.systemPrompt.trim()) {
    parts.push(`\n### ${skill.skillName} — তোমার ভূমিকা ও সীমা\n${skill.systemPrompt.trim()}`)
  }
  parts.push(`\n### ${skill.skillName} — কাজের ধাপ (procedure)\n${skill.instructions.trim()}`)
  if (skill.announce?.trim()) parts.push(`\n${skill.announce.trim()}`)
  return parts.join('\n')
}

/**
 * ENFORCEMENT, not a promise.
 *
 * Every rule in this session has held because something was WITHHELD, never
 * because the wording asked nicely. The isolation claim is checkable the same
 * way: take the prompt that was actually built and look for the text of any
 * prompt module that is not part of the kernel. A leak means the swap did not
 * happen — the test fails, and the live path logs it.
 *
 * Matching is done on a distinctive slice of each module rather than the whole
 * text, so trailing-whitespace differences cannot hide a leak.
 */
export interface PromptModuleLike {
  id: string
  text: string
  core?: boolean
}

const PROBE_CHARS = 120

function probe(text: string): string {
  return text.trim().slice(0, PROBE_CHARS)
}

/** Ids of NON-kernel prompt modules whose text leaked into an isolated prompt. */
export function findPromptLeaks(prompt: string, modules: PromptModuleLike[]): string[] {
  const leaks: string[] = []
  for (const m of modules) {
    if (m.core) continue
    const p = probe(m.text)
    if (p.length < 40) continue // too short to identify reliably
    if (prompt.includes(p)) leaks.push(m.id)
  }
  return leaks
}
