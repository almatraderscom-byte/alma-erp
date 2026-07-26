/**
 * Global policy for the model-loop's "you announced work, do it now" nudge.
 *
 * The nudge is useful when a model really stops at "let me check" without
 * calling a tool. It must never turn a completed answer, an owner-directed
 * question, or an honest tool failure into another hidden user turn.
 */

export interface TurnLoopToolRecord {
  status: 'success' | 'error'
  /** Name of the tool, when the caller has it — lets the failure guard tell a
   *  concrete recovery ("now get_staff_tasks") from hammering the same call. */
  toolName?: string
}

// A permission question may be followed by a parenthetical detail, as in the
// incident: "proposal ready করব কি? (Eyafi-কে ১০টা...)". It is still a handoff
// to the owner, never a promise that the server should auto-execute.
const OWNER_QUESTION_TAIL_RE = /[?？](?:\s*[\[(][\s\S]*[\])])?\s*$/i
const OWNER_PERMISSION_QUESTION_RE =
  /(?:করব(?:ো)?|পাঠাব|বানাব|শুরু\s*করব|এগোব|চান|অনুমতি|approve|should\s+i|shall\s+i|want\s+me\s+to)[^?？]{0,180}[?？]/i

// These are terminal/reporting phrases, not promises to keep acting. Keep this
// tool-agnostic so every task category gets the same protection.
const BLOCKED_OR_FAILED_RE =
  /(পারিনি|পারি\s*নি|পারছি\s*না|সম্ভব\s*(?:হয়নি|হয়নি|নয়|নয়)|ব্যর্থ|অফলাইন|সংযোগহীন|সংযোগ\s*(?:নেই|পাওয়া\s*যায়নি|পাওয়া\s*যায়নি)|অনুমতি\s*(?:নেই|লাগবে)|লগইন\s*(?:করুন|লাগবে)|captcha|otp|offline|failed|failure|error|cannot|can't|could\s*not|unavailable|not\s*available|not\s*connected|pairing\s*(?:required|needed))/i

const ADAPTER_INTENT_RE =
  /(করা\s*হবে|করব(ো)?(?![ঀ-ৼ])|করে\s*দিচ্ছি|করে\s*দেব|নির্বাচন\s*কর|সিলেক্ট\s*কর(ব|ছি|া\s*হবে)|ক্লিক\s*কর(ব|ছি|া\s*হবে)|পরের\s*ধাপে|খুলছি|খুলব(?![ঀ-ৼ])|খুলে\s*দিচ্ছ|যাচ্ছি|চালাচ্ছি|শুরু\s*কর(ছি|ব)(?![ঀ-ৼ])|চেষ্টা\s*কর(ছি|ব)(?![ঀ-ৼ])|নেভিগেট\s*কর|ওপেন\s*কর|দেখি(?![ঀ-ৼ])|দেখছি|দেখে\s*নিচ্ছি|দেখব(?![ঀ-ৼ])|স্ক্র(ো|)ল\s*কর|খুঁজ(ছি|ব)|opening\s|navigating\s|scrolling\s|let me\s|i('|’)?ll\s|now i (will|am)|going to\s)/i

const ZERO_TOOL_INTENT_RE =
  /(দিয়ে\s*দেখি|করে\s*দেখি|চেক\s*কর(ি|ছি)|দেখে\s*নিই|দেখে\s*নি|বের\s*কর(ি|ছি)|চালাই|চালাচ্ছি|টান(ি|ছি)|আনছি|আগে.*দেখি|let me (check|look|see|pull|run|fetch)|i('|’)?ll (check|look|see|pull|run|fetch|grab)|i will (check|look|see|pull|run|fetch)|going to (check|look|run|pull|fetch)|let's (check|look|run|see))/i

/**
 * A failure report that names a DIFFERENT, CONCRETE tool as the next step is a
 * recovery in progress, not a stop: "প্রস্তাব টুল ব্যর্থ — আগে get_staff_tasks
 * দিয়ে দেখে নিচ্ছি।" Ending the turn there means the head promised a recovery
 * and never ran it (found 2026-07-25 by testing a staff-dispatch request
 * instead of repeating the same ads question).
 *
 * The test is deliberately NARROW — a literal snake_case tool name that isn't
 * the one that just failed. Vague promises ("আবার চেষ্টা করব", "অন্যভাবে দেখব")
 * stay terminal: those are how a head hammers a broken call, which is exactly
 * what the failure guard exists to prevent.
 */
const TOOL_NAME_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g

function namesDifferentTool(text: string, failedTool?: string): boolean {
  const tail = text.trim().slice(-300)
  for (const m of tail.match(TOOL_NAME_RE) ?? []) {
    if (m !== failedTool) return true
  }
  return false
}

function isTerminalReply(text: string, failedTool?: string, lastFailed = false): boolean {
  const normalized = text.trim()
  if (!normalized) return true
  if (OWNER_QUESTION_TAIL_RE.test(normalized)) return true
  if (OWNER_PERMISSION_QUESTION_RE.test(normalized.slice(-800))) return true
  if (!BLOCKED_OR_FAILED_RE.test(normalized)) return false
  // Blocked/failed report → terminal unless a concrete different tool follows it.
  return !(lastFailed && namesDifferentTool(normalized, failedTool))
}

/**
 * "I am doing it right now" — present continuous, no deferral. This is the tail
 * of a turn that was cut off mid-step, not the tail of a finished report.
 */
const IN_FLIGHT_RE =
  /(খুঁজছি|দেখছি|দেখে\s*নিচ্ছি|চালাচ্ছি|করছি|নিচ্ছি|যাচ্ছি|খুলছি|আনছি|টানছি|পড়ছি|বের\s*করছি|checking|fetching|running|looking\s+up|pulling)/i

/** …unless it is explicitly parked for later, which is a legitimate sign-off. */
const DEFERRED_RE =
  /(পরের\s*ধাপে|পরে\s*(?:দেখব|করব|জানাব)|পরবর্তীতে|আগামী|next\s+step|later\b|afterwards)/i

function isWorkInFlight(text: string): boolean {
  const tail = text.trim().slice(-300)
  if (DEFERRED_RE.test(tail)) return false
  return IN_FLIGHT_RE.test(tail)
}

/**
 * OWNER OBSERVATION 2026-07-27 — one reply opened with the same sentence twice:
 *
 *   "বস, আপনি এখন কোনো SEO fix কাজ করার দরকার নেই বলেছেন — চলমান seo task-এর স্ট্যাটাস যাচাই করছি।"
 *   "বস, আপনি এখন কোনো SEO fix কাজ করার দরকার নেই বলেছেন — seo task-এর চলমান স্ট্যাটাস যাচাই করছি।"
 *
 * Speak-first streams the opening line in its own round and seeds it into the
 * transcript as the assistant's own words, precisely so the model continues
 * instead of greeting Boss again. It mostly works — and when it does not, the
 * paraphrase is close but not identical, so no exact-match check catches it.
 *
 * Asking the prompt more firmly is a request. Comparing the two lines is a
 * guarantee, and it is cheap: the tool-round prose arrives as one block, so a
 * duplicate is dropped before Boss ever sees it.
 *
 * Deliberately conservative. The threshold is high and the check only applies to
 * the FIRST prose after the preamble; a genuine progress line ("catalogue পড়া
 * শেষ, এখন audit চালাচ্ছি") shares few words with the opener and survives.
 */
const OPENER_SIMILARITY = 0.75

function words(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1)
}

export function isRepeatedOpener(preamble: string, next: string): boolean {
  const a = words(preamble)
  const b = words(next)
  if (a.length < 4 || b.length < 4) return false
  // A restatement is not usually much longer than the line it restates; a real
  // progress update that happens to echo some words is.
  if (b.length > a.length * 1.8) return false
  const setA = new Set(a)
  const shared = b.filter((w) => setA.has(w)).length
  const union = new Set([...a, ...b]).size
  return shared / union >= OPENER_SIMILARITY || shared / b.length >= 0.9
}

export function shouldNudgeAdapterIntent(input: {
  text: string
  toolRecords: TurnLoopToolRecord[]
  hasAskCard?: boolean
  ownerRequestedAction: boolean
}): boolean {
  // A turn that ran NO tool at all and signs off with "… চালাচ্ছি / দেখছি" is
  // unfinished by definition — whether or not the message asked for a mutation.
  // The old `ownerRequestedAction` requirement made read-only turns exempt, so a
  // head that announced a lookup and stopped ended the turn there (owner hit
  // this live 2026-07-25: "list_family_contacts চালাচ্ছি।" and nothing else).
  //
  // Round 2, 2026-07-26. That fix only covered turns where NO tool ran, so this
  // still died: Boss typed "almatraders.com এর ছবির alt ঠিক করো", the head read
  // the catalogue, said "এখন alt text update-এর জন্য সঠিক SEO tool খুঁজছি" — and
  // ended the turn at 25 seconds. One successful read had made noToolRan false,
  // and the turn was not mutation-authorised, so the guard bailed.
  //
  // The line that matters is not "was this turn allowed to write" — it is "is the
  // head in the MIDDLE of something". "খুঁজছি / দেখছি / চালাচ্ছি" is work in flight
  // and stopping there strands it; "পরের ধাপে dispatch দেখব" is a finished report
  // that mentions what comes later, and pushing on that would be nagging.
  const noToolRan = input.toolRecords.length === 0
  if (!input.ownerRequestedAction && !noToolRan && !isWorkInFlight(input.text)) return false
  const latestTool = input.toolRecords.at(-1)
  const lastFailed = latestTool?.status === 'error'
  if (input.hasAskCard || isTerminalReply(input.text, latestTool?.toolName, lastFailed)) return false
  // A failed last tool normally ends the turn — we must not hammer a broken
  // call. But when the head has just named a DIFFERENT concrete tool as its next
  // step, stopping is the bug: it promised a recovery and never ran it. The
  // caller bounds this to one nudge per turn, so it cannot become a retry loop.
  if (lastFailed && !namesDifferentTool(input.text, latestTool?.toolName)) return false
  return ADAPTER_INTENT_RE.test(input.text.trim().slice(-600))
}

export function shouldNudgeZeroToolIntent(input: {
  text: string
  hasAskCard?: boolean
  ownerRequestedAction: boolean
}): boolean {
  if (!input.ownerRequestedAction) return false
  if (input.hasAskCard || isTerminalReply(input.text)) return false
  return ZERO_TOOL_INTENT_RE.test(input.text)
}

/**
 * A provider retry/fallback restarts the whole owner turn. That is safe only
 * before the turn has produced any visible text, tool attempt, or owner handoff.
 * Once any of those exists, restarting can repeat arbitrary work and charge the
 * owner for a second execution of the same request.
 */
export function shouldRestartHeadAfterFailure(input: {
  text: string
  toolRecords: TurnLoopToolRecord[]
  hasAskCard?: boolean
}): boolean {
  return !input.text.trim() && input.toolRecords.length === 0 && !input.hasAskCard
}
