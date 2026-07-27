/**
 * SK-3 — the three-layer skill router (U4).
 *
 * Settled by measurement, not opinion. The owner put the same architecture
 * question to Codex, which argued the MODEL should choose; I had argued the
 * SERVER should. SK-0 answered it: pure keyword routing scores 61% on his real
 * messages, so neither extreme is right.
 *
 *   1. FILTER  — the server removes what is not eligible at all: draft skills,
 *                `implicit: false`, and anything whose declared dependencies are
 *                missing. Free, and it can never be argued with.
 *   2. RULES   — a short ordered decision list settles the cases a keyword can
 *                never see. "ঠিক করো" is a fix; "অডিট করো" is an audit. That one
 *                confusion cost a day this week, so it does not go to a model.
 *   3. MODEL   — only what is left. When the top two candidates are close, the
 *                router says so and the caller asks the head to choose among a
 *                shortlist. At most once per conversation, because of the pin.
 *
 * Every decision carries a TRACE (U5): which layer decided, why, and what the
 * runner-up was. A wrong pin then has an answer instead of a guess.
 */
import { selectSkills } from '@/agent/lib/skill-engine/loader'
import type { SkillIndex, SkillMetadata } from '@/agent/lib/skill-engine/types'

export type RouteLayer = 'rule' | 'keyword' | 'model' | 'none'

export interface RouteCandidate {
  name: string
  score: number
}

export interface RouteDecision {
  /** The skill to pin, or null. When `needsModel` is true this is the best guess. */
  skill: string | null
  layer: RouteLayer
  /** Human-readable, stored with the turn — this is the trace (U5). */
  reason: string
  candidates: RouteCandidate[]
  /** True when layers 1–2 could not settle it and the head should choose. */
  needsModel: boolean
}

/** Below this margin between the top two, keyword scoring is a coin flip. */
export const AMBIGUITY_MARGIN = 3

/**
 * A keyword-only pin needs real evidence, not one incidental word. Measured:
 * "kalker order gulo dekhao" pinned the incident-diagnosis skill on a score of
 * 1 — a single token overlap. A wrong pin also pins a tool allowlist, so a weak
 * match must produce NO skill rather than a bad one.
 *
 * Calibrated on the owner corpus rather than chosen: a floor of 3 killed the
 * false trigger but also lost `alma-finance-brief` (72%); a floor of 2 keeps it
 * and still leaves zero false triggers (78%).
 */
export const MIN_KEYWORD_SCORE = 2

// ── Layer 1: eligibility ────────────────────────────────────────────────────

export interface RouteContext {
  /** Env var names that are actually set — for `dependencies.env`. */
  presentEnv?: Set<string>
  /** Skills the owner named explicitly; `implicit: false` ones need this. */
  namedByOwner?: string[]
}

export function eligibleSkills(index: SkillIndex, ctx: RouteContext = {}): SkillMetadata[] {
  const named = new Set(ctx.namedByOwner ?? [])
  return index.skills.filter((s) => {
    if (s.implicit === false && !named.has(s.name)) return false
    return true
  })
}

// ── Layer 2: the decision list ──────────────────────────────────────────────

/**
 * Work verbs — stems, because Bangla inflects (লিখ/লেখো/লিখে).
 *
 * OWNER-CAUGHT 2026-07-27: every stem here was Bangla SCRIPT only, and he types
 * BANGLISH most of the time. "almatraders.com er slug thik koro" — an
 * unmistakable fix order — matched nothing, so no rule fired, three skills tied
 * on keyword score and the READ-ONLY audit skill won. A fix order pinned to the
 * audit skill is the worst outcome the design has: it hands the head no write
 * tool at all. The romanised forms are not a nicety, they are how he writes.
 */
const FIX_VERB =
  /(ঠিক\s*কর|সমাধান\s*কর|সংশোধন|লিখ|লেখ|সেভ\s*কর|বসাও|বসিয়ে|যোগ\s*কর|আপডেট\s*কর'?|\bfix\b|\bwrite\b|\bupdate\b|\bapply\b)/i
/** The same verbs as he romanises them. Separate so each side stays readable. */
const FIX_VERB_BANGLISH =
  /\b(thik\s*kor|thik\s*kore|thk\s*kor|shomadhan|shongshodhon|likh|likhe|lekh|lekho|save\s*kor|boshao|bosao|jog\s*kor|update\s*kor|thik\s*kore\s*dao)/i
/** …unless the thing being asked for IS the audit or the report. */
const AUDIT_ASK =
  /((?:অডিট|audit)\s*(?:কর|চালাও|দাও|run|kor|koro|calao|chalao|dao)|রিপোর্ট\s*(?:বানা|তৈরি|দাও|লিখ)|\breport\b|report\s*(?:banao|dao|koro)|পূর্ণাঙ্গ\s*seo|\bdekho\b|\bdekhao\b)/i
/**
 * `slug` joins the clear SEO markers for the same reason: it is an on-page SEO
 * field in this business and nothing else, and its absence is what let the miss
 * above happen (the sentence carried no `seo`/`alt`/`meta` word at all).
 */
const SEO_TOPIC_CLEAR =
  /\bseo\b|এসইও|\balt\b|meta\s*(?:description|title|tag)|অডিট|audit|sitemap|canonical|\bslug\b|স্লাগ/i
/**
 * Bare "meta" is the ambiguity SK-0 caught: "meta description লিখে দাও" routed to
 * the Meta ADS campaign skill. One word, two businesses. It only counts as SEO
 * when a website is in the sentence — an ads message names a campaign or a
 * budget, not a domain.
 */
const META_BARE = /\bmeta\b/i

const OWN_SITE = /almatraders\.com|আমাদের\s*(?:সাইট|ওয়েবসাইট)|our\s+site/i
/** Any other domain mentioned — a client's site. */
const OTHER_DOMAIN = /\b(?!almatraders\.com)[a-z0-9-]+\.(?:com|net|org|io|xyz|shop|co)\b/i
const ANY_DOMAIN = /\b[a-z0-9-]+\.(?:com|net|org|io|xyz|shop|co)\b/i

export function isSeoTopic(text: string): boolean {
  if (SEO_TOPIC_CLEAR.test(text)) return true
  return META_BARE.test(text) && ANY_DOMAIN.test(text)
}

/**
 * "কে কখন আসছে" — a person's attendance. Keyword scoring cannot reach this at
 * all: he names the STAFF MEMBER ("Mustahid ajke kokhon asche?"), and a name is
 * not a keyword any skill can claim. It is the same shape as fix-vs-audit — a
 * deterministic distinction a model should never be asked to make.
 */
const STAFF_PRESENCE =
  /(kokhon\s*(?:asche|ashbe|eshe|ase)|কখন\s*(?:আসছে|আসবে|এসেছে|আসে)|\bke\s*ache\b|কে\s*আছে|hajir|হাজির|hajira|হাজিরা|attendance|উপস্থিত)/i
/**
 * …unless it is a PARCEL arriving, not a person. "order kokhon asche" is a
 * customer question and pinning the staff skill there would remove the order
 * tools the answer actually needs. `delivery` is deliberately NOT here: "delivery
 * ke korbe" is a dispatch question, which is exactly this skill's job.
 */
const PARCEL_CONTEXT = /(\border\b|অর্ডার|parcel|পার্সেল|courier|কুরিয়ার|shipment|চালান)/i

export interface RouterRule {
  id: string
  skill: string
  test: (text: string) => boolean
  why: string
}

/**
 * Ordered — first match wins. Each rule exists because a real message went to
 * the wrong place; the `why` is what gets stored in the trace.
 */
export const RULES: RouterRule[] = [
  {
    id: 'client-site-seo',
    skill: 'seo-fixing-client-site',
    test: (t) => isSeoTopic(t) && OTHER_DOMAIN.test(t) && !OWN_SITE.test(t),
    why: 'SEO কাজ, কিন্তু অন্য কারও সাইট — আমাদের DB টুল ওখানে চলে না',
  },
  {
    id: 'own-site-audit',
    skill: 'seo-auditing-own-site',
    test: (t) => isSeoTopic(t) && AUDIT_ASK.test(t),
    why: 'অডিট/রিপোর্ট নিজেই চাওয়া হয়েছে — পড়ার কাজ, লেখার নয়',
  },
  {
    id: 'own-site-fix',
    skill: 'seo-fixing-own-site',
    test: (t) => isSeoTopic(t) && (FIX_VERB.test(t) || FIX_VERB_BANGLISH.test(t)) && !AUDIT_ASK.test(t),
    why: 'কাজের ক্রিয়াপদ + SEO বিষয় = ফিক্স, রিপোর্ট নয়',
  },
  {
    id: 'staff-attendance',
    skill: 'alma-staff-dispatch',
    test: (t) => STAFF_PRESENCE.test(t) && !PARCEL_CONTEXT.test(t),
    why: 'কে কখন আসছে/আছে — মানুষের হাজিরার প্রশ্ন, পার্সেলের নয়',
  },
]

export function applyRules(text: string): RouterRule | null {
  return RULES.find((r) => r.test(text)) ?? null
}

// ── The router ──────────────────────────────────────────────────────────────

export function routeSkill(index: SkillIndex, text: string, ctx: RouteContext = {}): RouteDecision {
  const t = (text ?? '').trim()
  if (!t) {
    return { skill: null, layer: 'none', reason: 'খালি মেসেজ', candidates: [], needsModel: false }
  }

  const eligible = eligibleSkills(index, ctx)
  const known = new Set(eligible.map((s) => s.name))

  // Layer 2 — a rule wins outright, even over a strong keyword score.
  const rule = applyRules(t)
  if (rule) {
    return {
      skill: rule.skill,
      layer: 'rule',
      reason: `${rule.id}: ${rule.why}`,
      candidates: [{ name: rule.skill, score: Infinity }],
      // A rule may name a skill that has not been written yet (SK-5). Say so
      // rather than silently falling through to a worse answer.
      needsModel: false,
    }
  }

  // Layer 3 — keyword scoring over the eligible set.
  const picked = selectSkills({ skills: eligible, warnings: [] }, t)
  const scored = scoreCandidates({ skills: eligible, warnings: [] }, t)
  if (picked.length === 0) {
    return { skill: null, layer: 'none', reason: 'কোনো skill যথেষ্ট মেলেনি', candidates: scored, needsModel: false }
  }

  const top = scored[0]
  const second = scored[1]
  if (!top || top.score < MIN_KEYWORD_SCORE) {
    return {
      skill: null,
      layer: 'none',
      reason: `সবচেয়ে কাছের মিল দুর্বল (${top?.name ?? '—'}: ${top?.score ?? 0}) — ভুল skill pin করার চেয়ে কোনোটা না করা ভালো`,
      candidates: scored.slice(0, 3),
      needsModel: false,
    }
  }
  const margin = top && second ? top.score - second.score : Infinity
  const ambiguous = margin < AMBIGUITY_MARGIN

  return {
    skill: known.has(picked[0].name) ? picked[0].name : null,
    layer: ambiguous ? 'model' : 'keyword',
    reason: ambiguous
      ? `${top.name} (${top.score}) আর ${second.name} (${second.score}) কাছাকাছি — head বেছে নেবে`
      : `keyword score ${top.score}, পরেরটা ${second?.score ?? 0}`,
    candidates: scored.slice(0, 3),
    needsModel: ambiguous,
  }
}

/** Scores exposed for the trace — same weighting the selector uses. */
export function scoreCandidates(index: SkillIndex, text: string): RouteCandidate[] {
  const q = new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2))
  return index.skills
    .map((s) => {
      let score = 0
      for (const kw of s.keywords) {
        if (kw.includes(' ')) {
          if (text.toLowerCase().includes(kw)) score += 3
        } else if (q.has(kw)) score += 2
      }
      for (const tok of `${s.name} ${s.description}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (tok.length > 2 && q.has(tok)) score += 1
      }
      return { name: s.name, score }
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

// ── U3: the registry budget ─────────────────────────────────────────────────

/**
 * The always-loaded name+description list. Codex's number for Codex itself is
 * ~2% of the context window, and the principle is the point: without a cap, the
 * cost of owning 100 skills is invisible until the bill arrives.
 */
export const REGISTRY_BUDGET_CHARS = 6000
const MIN_DESCRIPTION_CHARS = 80

export interface RegistryBlock {
  text: string
  included: string[]
  /** Skills that did not fit — visible, never silently dropped. */
  dropped: string[]
  shortened: boolean
}

export function buildRegistryBlock(
  skills: SkillMetadata[],
  budget = REGISTRY_BUDGET_CHARS,
): RegistryBlock {
  const line = (s: SkillMetadata, desc: string) => `- ${s.name}: ${desc}`
  const full = skills.map((s) => line(s, s.description))
  const fullSize = full.join('\n').length
  if (fullSize <= budget) {
    return { text: full.join('\n'), included: skills.map((s) => s.name), dropped: [], shortened: false }
  }

  // First try shortening every description before dropping anything.
  const short = skills.map((s) => line(s, s.description.slice(0, MIN_DESCRIPTION_CHARS).trim()))
  if (short.join('\n').length <= budget) {
    return { text: short.join('\n'), included: skills.map((s) => s.name), dropped: [], shortened: true }
  }

  // Still over: keep as many as fit, in the order given (caller ranks them).
  const kept: string[] = []
  const included: string[] = []
  let size = 0
  for (let i = 0; i < skills.length; i++) {
    const next = short[i]
    if (size + next.length + 1 > budget) break
    kept.push(next)
    included.push(skills[i].name)
    size += next.length + 1
  }
  return {
    text: kept.join('\n'),
    included,
    dropped: skills.slice(included.length).map((s) => s.name),
    shortened: true,
  }
}
