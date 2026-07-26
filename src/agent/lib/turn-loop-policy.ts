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
  /** Stable error code from the tool envelope, when the caller has it. Lets the
   *  failure guard tell a BROKEN call from a badly-ARGUED one. */
  errorCode?: string
}

/**
 * Failures that mean "you called it wrong", not "it does not work".
 *
 * Owner watched this live 2026-07-27: audit_product_seo failed on its arguments,
 * the head said *"ভুল ছিল … এখন সঠিকভাবে চালাচ্ছি"* — and the turn ended, because
 * the guard below saw the same tool named again and refused to push, treating a
 * self-correction as hammering. A corrected retry is the opposite of hammering:
 * it is the recovery the whole self-correction machinery exists to produce.
 */
const ARGUMENT_ERROR_CODES = new Set(['invalid_args', 'malformed_args'])

export function isArgumentFailure(record: TurnLoopToolRecord | undefined): boolean {
  return record?.status === 'error' && !!record.errorCode && ARGUMENT_ERROR_CODES.has(record.errorCode)
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
  // An admission plus work in flight is not a sign-off — it is "I got that wrong,
  // I am doing it properly now". Since 2026-07-27 the verifier REQUIRES that
  // admission when an opening-line promise went unmet, so without this line the
  // honesty fix would itself end the turn: the word পারিনি appears, the reply
  // reads as blocked, and the push that would have finished the job is suppressed.
  if (isWorkInFlight(normalized)) return false
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
  // …unless the failure was the ARGUMENTS. Then naming the same tool again is
  // the correction, not the repetition, and stopping there strands the job one
  // step from done (owner, live 2026-07-27).
  if (lastFailed && !isArgumentFailure(latestTool) && !namesDifferentTool(input.text, latestTool?.toolName)) return false
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
