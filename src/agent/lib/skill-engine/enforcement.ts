/**
 * SK-4 — making the pinned skill binding.
 *
 * Everything in this session points the same way: a prompt rule is a request, an
 * absent tool is a guarantee. Listen mode held because the tools were withheld.
 * Chat modes held because the tools were withheld. "Don't ask me" held because
 * `ask_user` was withheld. So a skill becomes real here, not in its wording.
 *
 * Three enforcements, in order of how much they buy:
 *
 *  1. TOOL ALLOWLIST — a read-only audit skill is handed no write tool, so it
 *     cannot write whatever it decides. This is the one that actually holds.
 *  2. DEPENDENCIES — declared in the skill, checked BEFORE step 0. The alt-text
 *     job burned 15 steps and 1m36s finding out the website DB was unreachable
 *     one tool at a time; a declared dependency makes that one sentence.
 *  3. DONE GATE — `done:` checked against real tool records. "হয়ে গেছে" stops
 *     being a sentence the model can emit at will.
 *
 * Pure module: no I/O, no prisma. Everything is a function of the manifest plus
 * what the turn actually did.
 */
import type { SkillManifest } from '@/agent/lib/skill-engine/types'

export interface SkillToolRecord {
  toolName: string
  status: 'success' | 'error'
}

/** Tools every skill keeps — discovery and honest escalation are never removed. */
export const ALWAYS_ALLOWED = new Set([
  'find_tool',
  'ask_user',
  'save_memory',
  'request_agent_action',
  // The owner's own Mac. These are owner-service capabilities, like ask_user:
  // when he says "open a Claude session on my Mac", that must work regardless of
  // which skill the router happened to pin. Live-hit 2026-08-01: an unrelated
  // invoice skill was pinned on exactly that sentence and stripped every Mac
  // tool, so the head truthfully reported it could not open a session.
  // Skill isolation is not what keeps these safe — the command classifier and
  // the approval cards are, and both still apply.
  'run_mac_command',
  'check_mac_command',
  'mac_agent_status',
  'mac_desk_control',
  'start_cli_session',
  'send_to_cli_session',
  'read_cli_session',
  'stop_cli_session',
  'list_cli_sessions',
])

/**
 * The skill's allowlist. `requiredCapabilities` is the existing manifest field
 * and already CI-validated against the live registry, so a skill can never name
 * a tool that does not exist.
 *
 * An EMPTY allowlist means "this skill does not narrow tools" — not "no tools".
 * Silently handing a skill zero tools would be a far worse failure than not
 * enforcing at all.
 */
export function skillAllowlist(manifest: Pick<SkillManifest, 'requiredCapabilities'>): Set<string> | null {
  const caps = manifest.requiredCapabilities ?? []
  if (caps.length === 0) return null
  return new Set([...caps, ...ALWAYS_ALLOWED])
}

export interface ToolLike { name: string }

export function filterToolsForSkill<T extends ToolLike>(
  tools: T[],
  manifest: Pick<SkillManifest, 'requiredCapabilities'>,
): { tools: T[]; removed: string[] } {
  const allow = skillAllowlist(manifest)
  if (!allow) return { tools, removed: [] }
  const kept = tools.filter((t) => allow.has(t.name))
  return { tools: kept, removed: tools.filter((t) => !allow.has(t.name)).map((t) => t.name) }
}

// ── 2. Dependencies ─────────────────────────────────────────────────────────

export interface DependencyGap {
  kind: 'env'
  name: string
}

/** What the skill declared it needs and the environment does not have. */
export function skillDependencyGaps(
  manifest: Pick<SkillManifest, 'dependencies'>,
  env: NodeJS.ProcessEnv = process.env,
): DependencyGap[] {
  const gaps: DependencyGap[] = []
  for (const name of manifest.dependencies?.env ?? []) {
    if (!String(env[name] ?? '').trim()) gaps.push({ kind: 'env', name })
  }
  return gaps
}

/** The sentence Boss should get in the FIRST reply when a dependency is missing. */
export function dependencyBlockMessage(skill: string, gaps: DependencyGap[]): string {
  if (gaps.length === 0) return ''
  const names = gaps.map((g) => g.name).join(', ')
  return (
    `\n## এই skill এখন চলবে না\n`
    + `\`${skill}\`-এর জন্য দরকার: ${names} — যা সেট করা নেই।\n`
    + `প্রথম উত্তরেই Boss-কে সোজা বলো কোনটা নেই আর কোথায় বসাতে হবে, তারপর থামো। `
    + `ঘুরপথ খুঁজো না, আর সেভ করা যাবে না এমন কনটেন্ট আগেভাগে বানিয়ো না।\n`
  )
}

/**
 * Bangla + English completion claims. Narrow on purpose: it must catch "কাজ শেষ"
 * and "হয়ে গেছে" while NOT catching "শেষ হয়নি", which is the honest report this
 * week was spent teaching the agent to produce.
 */
const CLAIMS_DONE_RE =
  /(হয়ে\s*গে(ছে|লো)|কাজ\s*শেষ|সম্পন্ন\s*হয়েছে|শেষ\s*করেছি|করে\s*দিয়েছি|আপডেট\s*হয়েছে|\bdone\b|\bcompleted\b|\bfinished\b)/i
const DENIES_DONE_RE =
  /(শেষ\s*হয়নি|হয়নি|পারিনি|করা\s*যায়নি|আটকে|বাকি\s*আছে|not\s+(?:done|complete)|could\s*not|failed)/i

export function claimsCompletion(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (DENIES_DONE_RE.test(t)) return false
  return CLAIMS_DONE_RE.test(t)
}

// ── 3. The done gate ────────────────────────────────────────────────────────

export interface DoneMiss {
  kind: 'tool' | 'check'
  name: string
}

/**
 * Which of the skill's `done:` conditions are NOT met. Tool conditions are
 * checked against real successful calls; named `check:` conditions are returned
 * for the caller's own verifier (the grind engine owns those).
 */
export function skillDoneMisses(
  manifest: Pick<SkillManifest, 'done'>,
  records: SkillToolRecord[],
  passedChecks: string[] = [],
): DoneMiss[] {
  const misses: DoneMiss[] = []
  for (const cond of manifest.done ?? []) {
    if (cond.tool) {
      const ok = records.some((r) => r.toolName === cond.tool && r.status === 'success')
      if (!ok) misses.push({ kind: 'tool', name: cond.tool })
    }
    if (cond.check && !passedChecks.includes(cond.check)) {
      misses.push({ kind: 'check', name: cond.check })
    }
  }
  return misses
}

/**
 * The line that replaces a premature "হয়ে গেছে". It names what is left rather
 * than scolding — Boss needs the remaining work, not a lecture.
 */
export function doneGateMessage(skill: string, misses: DoneMiss[]): string {
  if (misses.length === 0) return ''
  const parts = misses.map((m) => (m.kind === 'tool' ? `${m.name} চালানো হয়নি` : m.name))
  return `⚠️ \`${skill}\` skill-এর শর্ত এখনো পূরণ হয়নি — ${parts.join(', ')}। তাই "হয়ে গেছে" বলছি না।`
}
