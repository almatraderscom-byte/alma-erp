/**
 * SK-2 — the skill linter.
 *
 * A 2026 review of 238 real-world skills found 99% carried at least one flaw a
 * routine review catches. Ours are no exception: SK-0 measured "meta description
 * লিখে দাও" routing to the Meta ADS campaign skill, purely because two
 * descriptions collided on one word.
 *
 * So the rules here are not style policing. Each one maps to a way a skill fails
 * in production:
 *
 *   description quality  → the skill never triggers, or triggers on everything
 *   description overlap  → the WRONG skill triggers (U7)
 *   multi-purpose skill  → behaviour becomes unpredictable (U7)
 *   body length          → "comprehensive" skills measured +0.7 vs +19 compact
 *   missing v2 contract  → a writing skill with no stop conditions or done gate
 *
 * Pure module: takes parsed skill data, returns findings. No filesystem, so it
 * is trivially testable and can run in CI, in a test, or behind an editor.
 */

export type LintSeverity = 'error' | 'warn'

export interface LintFinding {
  skill: string
  rule: string
  severity: LintSeverity
  message: string
}

/** Everything the linter needs about one skill. */
export interface LintableSkill {
  name: string
  description: string
  /** SKILL.md body, frontmatter stripped. */
  body: string
  status: string
  /** manifest.writePolicy — 'none' means the skill cannot change anything. */
  writePolicy?: string
  whenNotToUse?: string
  stopConditions?: string[]
  done?: Array<{ tool?: string; check?: string }>
  outputContract?: { kind: string; mustInclude?: string[] }
  dependencies?: { env?: string[]; capability?: string[] }
  requiredCapabilities?: string[]
  /** Routing keywords from SKILL.md frontmatter. */
  keywords?: string[]
  /** U8 — false means it is inherited, never selected. */
  implicit?: boolean
}

/** Compact wins: +19.0 vs +0.7 for "comprehensive". 200 lines is our ceiling. */
export const MAX_BODY_LINES = 200
export const MAX_DESCRIPTION_CHARS = 1024
/**
 * Above this Jaccard overlap two descriptions compete for the same messages.
 * Calibrated on our own 16 skills rather than guessed: the worst real pair is
 * `alma-customer-support` ~ `alma-product-social-post` at 40%, and those two DO
 * fight over "customer … message … post" phrasing. Everything else is ≤13%.
 * A limit of 0.5 (the first guess) would never have fired on anything.
 */
export const DESCRIPTION_OVERLAP_LIMIT = 0.35

const FIRST_PERSON_RE = /\b(I can|I will|I'll|I am|we can|we will)\b/i
const SECOND_PERSON_RE = /\b(you can use this|you should use|use this to)\b/i
/** "when to use" signal, in either language the owner writes. */
const WHEN_RE = /(use when|use for|when the owner|when boss|যখন|ব্যবহার করবে|ব্যবহার করো|use it when)/i

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESERVED = ['anthropic', 'claude']

/**
 * The purposes a skill may have exactly one of (U7).
 *
 * Verification is deliberately NOT one of them. The first version listed it, and
 * it flagged both new SEO skills — wrongly: every good skill verifies its own
 * work, and the research says so explicitly. A rule that punishes the thing we
 * want in every skill is a broken rule.
 */
const PURPOSES: Array<{ id: string; re: RegExp }> = [
  { id: 'audit', re: /(audits?|auditing|অডিট|analys[ei]|analyz[ei]|reviews?|পর্যালোচনা|reports?|রিপোর্ট)/i },
  { id: 'edit', re: /(fix(es|ing|ed)?|edits?|updates?|writes?|writing|ঠিক\s*কর|লিখ|আপডেট|সংশোধন)/i },
  { id: 'deploy', re: /(deploys?|publish(es|ing)?|launch(es|ing)?|ships?|প্রকাশ|লাইভ\s*কর)/i },
]

/**
 * A description's NEGATIVE half — "Not for producing an audit", "নয়" — says what
 * the skill refuses, which is the opposite of a claimed purpose. Counting it was
 * the second half of the same bug.
 */
/**
 * Extended 2026-07-27, from a real mis-flag rather than a hunch. `alma-website`
 * was scored as claiming audit + edit + deploy on the strength of the sentences
 * that REFUSE those things: "workbench কখনো সরাসরি deploy করে না", "পণ্য
 * publish/update এই skill করে না", "টুলগুলো এই skill-এর হাতে নেই".
 *
 * The list knew only `করবে না` — the FUTURE negative ("will not do"). Bangla
 * writes a standing rule in the present: `করে না` ("does not do"), and states
 * absence with `নেই` / `হয়নি`. Missing those turned every honest boundary
 * statement into evidence of a purpose the skill was disclaiming — which
 * punishes exactly the skills that draw their limits most clearly.
 */
const NEGATIVE_CLAUSE =
  /(\bnot for\b|\bnever\b|\bdoes not\b|\bno longer\b|নয়\b|করবে না|করে না|যায় না|নেই\b|হয়নি|ছাড়া)/i

function positiveHalf(text: string): string {
  return text
    .split(/(?<=[.।])\s+/)
    .filter((sentence) => !NEGATIVE_CLAUSE.test(sentence))
    .join(' ')
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'use', 'when', 'with', 'from', 'this', 'that', 'into', 'via',
  'stay', 'stays', 'owner', 'gated', 'alma', 'not', 'any', 'all', 'its', 'are',
])

function tokens(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((t) => t.length > 3 && !STOPWORDS.has(t)),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

/** Which purposes a skill claims, judged on its description + first 40 lines. */
export function purposesOf(skill: LintableSkill): string[] {
  const head = positiveHalf(
    `${skill.description}\n${skill.body.split('\n').slice(0, 40).join('\n')}`,
  )
  return PURPOSES.filter((p) => p.re.test(head)).map((p) => p.id)
}

function lintOne(s: LintableSkill): LintFinding[] {
  const out: LintFinding[] = []
  const add = (rule: string, severity: LintSeverity, message: string) =>
    out.push({ skill: s.name, rule, severity, message })

  // ── name ────────────────────────────────────────────────────────────────
  if (!NAME_RE.test(s.name)) add('name-format', 'error', 'lowercase letters, digits and hyphens only')
  if (s.name.length > 64) add('name-length', 'error', `${s.name.length} chars, max 64`)
  for (const w of RESERVED) {
    if (s.name.includes(w)) add('name-reserved', 'error', `must not contain "${w}"`)
  }

  // ── description: the single biggest routing lever ────────────────────────
  const d = s.description.trim()
  if (!d) add('description-empty', 'error', 'description is what makes the skill selectable')
  if (d.length > MAX_DESCRIPTION_CHARS) {
    add('description-length', 'error', `${d.length} chars, max ${MAX_DESCRIPTION_CHARS}`)
  }
  if (FIRST_PERSON_RE.test(d) || SECOND_PERSON_RE.test(d)) {
    add('description-person', 'error', 'write in third person — it is injected into the system prompt')
  }
  // A skill that can never be auto-selected has nothing to route on, so the
  // "when to use it" half is meaningless for it (alma-base is inherited, not picked).
  if (d && !WHEN_RE.test(d) && s.implicit !== false) {
    add('description-when', 'warn', 'says WHAT it does but not WHEN to use it — the half routing needs')
  }

  // ── body: compact beats comprehensive, measurably ────────────────────────
  const lines = s.body.split('\n').length
  if (lines > MAX_BODY_LINES) {
    add('body-length', 'warn', `${lines} lines — move depth into reference files (max ${MAX_BODY_LINES})`)
  }
  if (!s.body.trim()) add('body-empty', 'error', 'SKILL.md has no procedure')

  // ── U7: one skill, one purpose ───────────────────────────────────────────
  const purposes = purposesOf(s)
  if (purposes.length > 2) {
    add(
      'multi-purpose',
      'warn',
      `claims ${purposes.join(' + ')} — split it; a skill that audits AND edits AND deploys behaves unpredictably`,
    )
  }

  // ── v2 contract, required once a skill can change anything ───────────────
  const writes = s.writePolicy && s.writePolicy !== 'none'
  if (writes) {
    if (!s.done?.length) add('missing-done', 'error', 'a writing skill needs a machine-checkable done list')
    if (!s.stopConditions?.length) {
      add('missing-stop-conditions', 'warn', 'a writing skill must say where it stops and asks Boss')
    }
    if (!s.outputContract) {
      add('missing-output-contract', 'warn', 'name the deliverable shape, not "a good report"')
    }
  }
  if (!s.whenNotToUse) {
    add('missing-when-not', 'warn', 'no `whenNotToUse` — this is the tie-break when two skills collide')
  }

  return out
}

/** Lint one skill in isolation plus every cross-skill rule. */
export function lintSkills(skills: LintableSkill[]): LintFinding[] {
  const findings = skills.flatMap(lintOne)

  // ── U7: description overlap — the failure SK-0 actually measured ─────────
  const toks = new Map(skills.map((s) => [s.name, tokens(s.description)]))
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i]
      const b = skills[j]
      const score = jaccard(toks.get(a.name)!, toks.get(b.name)!)
      if (score > DESCRIPTION_OVERLAP_LIMIT) {
        findings.push({
          skill: a.name,
          rule: 'description-overlap',
          severity: 'warn',
          message: `${Math.round(score * 100)}% overlap with ${b.name} — the router cannot tell them apart`,
        })
      }
    }
  }

  // ── U7, second half: a keyword two skills both claim ─────────────────────
  // This is the failure SK-0 actually measured — "meta description লিখে দাও"
  // landed on the Meta ADS campaign skill. Nothing was wrong with either
  // description; one WORD belonged to both, and the router coin-flipped.
  const owners = new Map<string, string[]>()
  for (const s of skills) {
    for (const kw of s.keywords ?? []) {
      const k = kw.trim().toLowerCase()
      if (!k || k.includes(' ')) continue // multi-word phrases are specific enough
      owners.set(k, [...(owners.get(k) ?? []), s.name])
    }
  }
  for (const [kw, claimed] of owners) {
    if (claimed.length > 1) {
      findings.push({
        skill: claimed[0],
        rule: 'keyword-collision',
        severity: 'warn',
        message: `"${kw}" is also claimed by ${claimed.slice(1).join(', ')} — the router cannot break this tie`,
      })
    }
  }

  // Duplicate names would make selection non-deterministic.
  const seen = new Set<string>()
  for (const s of skills) {
    if (seen.has(s.name)) {
      findings.push({ skill: s.name, rule: 'duplicate-name', severity: 'error', message: 'name used twice' })
    }
    seen.add(s.name)
  }

  return findings
}

export const errorsOnly = (f: LintFinding[]): LintFinding[] => f.filter((x) => x.severity === 'error')
