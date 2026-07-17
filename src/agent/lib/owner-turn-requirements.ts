/**
 * Deterministic requirements extracted from the OWNER'S message.
 *
 * These are control state, not prompt suggestions.  The model may choose how to
 * perform the work, but it may not silently drop an explicitly requested
 * surface (for example the owner's live Chrome) or one of an ordered list of
 * targets.
 */

import { AGENT_PLAN_GATE, AGENT_GROUNDING_GATE } from '@/agent/config'

export interface OwnerTurnRequirements {
  liveBrowser: boolean
  clientSeo: boolean
  reportArtifact: boolean
  remember: boolean
  targets: string[]
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

export function deriveOwnerTurnRequirements(text: string): OwnerTurnRequirements {
  const t = text.trim()
  const targets = extractOrderedWebTargets(t)
  const liveBrowser = /\blive[\s_-]*browser\b|আমার\s*(?:chrome|ক্রোম|browser|ব্রাউজার)|(?:chrome|ক্রোম|browser|ব্রাউজার)\s*(?:use|ব্যবহার|দিয়ে|diye)/i.test(t)
  const clientSeo = targets.length > 0 && /\bseo\b|এসইও|audit|অডিট/i.test(t)
  const reportArtifact = clientSeo && /report|রিপোর্ট|file|ফাইল|evidence|প্রমাণ|customer|client|কাস্টমার|ক্লায়েন্ট/i.test(t)
  const remember = /মনে\s*(?:রাখ|রেখ)|remember\s+this|save\s+(?:this\s+)?(?:to\s+)?memory|don't\s+forget/i.test(t)
  // P3/P2 — each gated by its own flag (off by default → false → no note, no bind).
  const planFirst = AGENT_PLAN_GATE && classifyPlanFirst(t)
  const groundingRequired = AGENT_GROUNDING_GATE && classifyGroundingRequired(t) && !remember && !liveBrowser
  return { liveBrowser, clientSeo, reportArtifact, remember, targets, planFirst, groundingRequired }
}

export function buildOwnerRequirementNote(req: OwnerTurnRequirements): string {
  const lines: string[] = []
  if (req.targets.length) lines.push(`Ordered targets: ${req.targets.join(' → ')}`)
  if (req.liveBrowser) {
    lines.push('Live Chrome is REQUIRED: visit and LOOK at at least 5 distinct pages per target; crawler-only completion is forbidden.')
  }
  if (req.clientSeo) lines.push('Each target requires its own crawl, executed result, full report read, and download links before moving on.')
  if (req.reportArtifact) lines.push('A client-ready artifact is REQUIRED; prose alone is not delivery.')
  if (req.remember) lines.push('save_memory is REQUIRED before acknowledging this explicit remember request.')
  if (req.planFirst) lines.push('Multi-step work: call make_plan FIRST, then execute step by step, then self-check — do not tool-spray.')
  if (req.groundingRequired) lines.push('Live-data question: read the current value with a tool BEFORE answering — never state a number/status from memory.')
  if (!lines.length) return ''
  return `[SERVER REQUIREMENT CONTRACT — derived from Boss's exact message; cannot be waived by the model]\n${lines.map((l) => `• ${l}`).join('\n')}`
}
