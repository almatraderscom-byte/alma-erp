/**
 * Deterministic requirements extracted from the OWNER'S message.
 *
 * These are control state, not prompt suggestions.  The model may choose how to
 * perform the work, but it may not silently drop an explicitly requested
 * surface (for example the owner's live Chrome) or one of an ordered list of
 * targets.
 */

import { AGENT_PLAN_GATE, AGENT_GROUNDING_GATE } from '@/agent/config'
import { DEEP_SCOPE_RE } from '@/agent/lib/turn-authorization'

export interface OwnerTurnRequirements {
  liveBrowser: boolean
  clientSeo: boolean
  reportArtifact: boolean
  remember: boolean
  targets: string[]
  /**
   * Boss asked for DEEP / full / end-to-end work (2026-07-25 owner rule). Drives
   * the depth budget: a detailed answer plan instead of the ~10-line cap, and a
   * bigger tool-iteration budget. Never a trimmed-down version of the task.
   */
  deepWork: boolean
  /** P3 — clearly multi-step work → make_plan first (only true when AGENT_PLAN_GATE on). */
  planFirst: boolean
  /** P2 — live-data question → must read before answering (only true when AGENT_GROUNDING_GATE on). */
  groundingRequired: boolean
}

// P3/P2 — narrow, high-precision classifiers. Deliberately conservative: a false
// positive would force a needless make_plan / tool call, so we only fire on clear
// signals and fail open. Both are additionally gated by their env flag in derive.
const PLAN_REQUEST_RE = /\b(plan|প্ল্যান|ধাপে\s*ধাপে|step[\s-]*by[\s-]*step)\b/i
const SEQUENCE_MARKER_RE = /তারপর|এরপর|এর\s*পর|তার\s*পরে|\bthen\b|\bnext\b|erpor/gi
const DATA_NOUN_RE = /(order|অর্ডার|stock|স্টক|inventory|ইনভেন্টরি|balance|ব্যালান্স|ব্যালেন্স|বিক্রি|sales?|revenue|আয়|due|বাকি|payment|পেমেন্ট|staff|স্টাফ|customer|কাস্টমার|attendance|হাজিরা|cash|ক্যাশ|expense|খরচ)/i
const DATA_QUESTION_RE = /[?？]|\bকত\b|\bকয়\b|\bkoto\b|how\s+many|how\s+much|what\s+is|কেমন|অবস্থা|কি\s*আছে|আছে\s*কি|\bstatus\b|\blatest\b|সর্বশেষ|আজকের|\btoday\b/i

function classifyPlanFirst(t: string): boolean {
  if (PLAN_REQUEST_RE.test(t)) return true
  const markers = t.match(SEQUENCE_MARKER_RE)
  return markers ? markers.length >= 2 : false // ≥2 "then"-markers ⇒ ≥3 sequential steps
}

function classifyGroundingRequired(t: string): boolean {
  return DATA_NOUN_RE.test(t) && DATA_QUESTION_RE.test(t)
}

const DOMAIN_RE = /(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,})+)(?:\/[^\s,;]*)?/gi

function normalizeTarget(host: string): string {
  return `https://${host.toLowerCase().replace(/^www\./, '')}`
}

export function extractOrderedWebTargets(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(DOMAIN_RE)) {
    const target = normalizeTarget(match[1])
    if (!seen.has(target)) {
      seen.add(target)
      out.push(target)
    }
  }
  return out
}

/**
 * "Do the work" verbs. When Boss uses one of these about findings that already
 * exist, he wants execution — not another audit, and not another report.
 *
 * These are VERB STEMS, not whole phrases. The first version listed exact forms
 * (লেখো, লিখে দাও) and missed the very next thing he typed — "alt লিখে সেভ করো"
 * — so the audit contract armed again and the turn died demanding an audit tool.
 * Bangla inflects; match the stem (লিখ/লেখ/সেভ/বসা) and the forms come free.
 */
const FIX_INTENT_RE =
  /(?:ঠিক\s*কর|সমাধান\s*কর|সংশোধন|লিখ|লেখ|সেভ\s*কর|বসাও|বসিয়ে|যোগ\s*কর|জুড়ে\s*দাও|আপডেট\s*কর|apply|fix(?:ing|es|ed)?\b|implement|write|update|save|add\s+(?:the\s+)?alt)/i

/**
 * ...but a work verb inside a request FOR an audit or a report is still an audit
 * order ("SEO অডিট করে রিপোর্ট লিখে দাও"). The object of the verb decides, so an
 * explicit ask for the audit/report itself wins over the verb.
 */
const AUDIT_ASK_RE =
  /(?:অডিট|audit)\s*(?:কর|চালাও|দাও|run)|রিপোর্ট\s*(?:বানা|তৈরি|দাও|লিখ)|\breport\s+(?:on|for)\b/i

export function deriveOwnerTurnRequirements(text: string): OwnerTurnRequirements {
  const t = text.trim()
  const targets = extractOrderedWebTargets(t)
  const liveBrowser = /\blive[\s_-]*browser\b|আমার\s*(?:chrome|ক্রোম|browser|ব্রাউজার)|(?:chrome|ক্রোম|browser|ব্রাউজার)\s*(?:use|ব্যবহার|দিয়ে|diye)/i.test(t)
  // A FIX order is not an audit order (owner bug 2026-07-26). "almatraders.com
  // এর SEO অডিটে পাওয়া ছবির alt সমস্যা ঠিক করো" armed the audit contract purely
  // because it contains the words "SEO" and "অডিট" — so the agent produced ANOTHER
  // report instead of doing the work, and Boss's reaction was exactly right:
  // "agent ke kaj dile fix korte, kintu abar SEO report baniye dilo".
  const fixIntent = FIX_INTENT_RE.test(t) && !AUDIT_ASK_RE.test(t)
  const clientSeo = targets.length > 0 && /\bseo\b|এসইও|audit|অডিট/i.test(t) && !fixIntent
  // Owner standing rule (2026-07-25): a website audit ALWAYS ends in a
  // client-ready deliverable — the owner should never have to type the word
  // "report" to get one. Previously "Do a Deep SEO Audit - almatraders.com"
  // armed clientSeo but not reportArtifact, so the "prose alone is not
  // delivery" line was never emitted on the very turn that needed it.
  const reportArtifact = clientSeo
  const remember = /মনে\s*(?:রাখ|রেখ)|remember\s+this|save\s+(?:this\s+)?(?:to\s+)?memory|don't\s+forget/i.test(t)
  // P3/P2 — each gated by its own flag (off by default → false → no note, no bind).
  const planFirst = AGENT_PLAN_GATE && classifyPlanFirst(t)
  const groundingRequired = AGENT_GROUNDING_GATE && classifyGroundingRequired(t) && !remember && !liveBrowser
  const deepWork = DEEP_SCOPE_RE.test(t) || clientSeo
  return { liveBrowser, clientSeo, reportArtifact, remember, targets, deepWork, planFirst, groundingRequired }
}

/**
 * SK-6 — when a skill is pinned, the SEO-specific lines below are NOT emitted.
 *
 * They are task procedure ("crawl each target, read the report, produce an
 * artifact"), and task procedure is what a skill is for. Kept in global code they
 * are the owner's exact complaint: teaching the agent one job by editing a file
 * every other job also reads. They now live in `seo-fixing-client-site/SKILL.md`,
 * so with a skill pinned they would be said twice and could drift apart.
 *
 * The generic lines — ordered targets, live Chrome, remember, deep work — stay
 * unconditionally. They are true of any job, which is the test §6 of the plan
 * sets for what may remain global.
 */
export function buildOwnerRequirementNote(
  req: OwnerTurnRequirements,
  opts: { skillPinned?: boolean } = {},
): string {
  const lines: string[] = []
  if (req.targets.length) lines.push(`Ordered targets: ${req.targets.join(' → ')}`)
  if (req.liveBrowser) {
    lines.push('Live Chrome is REQUIRED: visit and LOOK at at least 5 distinct pages per target; crawler-only completion is forbidden.')
  }
  if (req.clientSeo && !opts.skillPinned) lines.push('Each target requires its own crawl, executed result, full report read, and download links before moving on.')
  if (req.reportArtifact && !opts.skillPinned) lines.push('A client-ready artifact is REQUIRED; prose alone is not delivery.')
  if (req.deepWork) {
    lines.push(
      'Boss asked for DEEP/full work: cover the complete end-to-end scope — a shortened or sampled version is a failure. '
        + 'Answer at full length when you deliver (the short-reply default does not apply to this delivery).',
    )
  }
  if (req.remember) lines.push('save_memory is REQUIRED before acknowledging this explicit remember request.')
  if (req.planFirst) lines.push('Multi-step work: call make_plan FIRST, then execute step by step, then self-check — do not tool-spray.')
  if (req.groundingRequired) lines.push('Live-data question: read the current value with a tool BEFORE answering — never state a number/status from memory.')
  if (!lines.length) return ''
  return `[SERVER REQUIREMENT CONTRACT — derived from Boss's exact message; cannot be waived by the model]\n${lines.map((l) => `• ${l}`).join('\n')}`
}
