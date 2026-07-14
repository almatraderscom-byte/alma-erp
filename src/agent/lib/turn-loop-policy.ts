/**
 * Global policy for the model-loop's "you announced work, do it now" nudge.
 *
 * The nudge is useful when a model really stops at "let me check" without
 * calling a tool. It must never turn a completed answer, an owner-directed
 * question, or an honest tool failure into another hidden user turn.
 */

export interface TurnLoopToolRecord {
  status: 'success' | 'error'
}

const OWNER_QUESTION_TAIL_RE = /(?:কি|কী)\s*[?？!।.\s]*$/i

// These are terminal/reporting phrases, not promises to keep acting. Keep this
// tool-agnostic so every task category gets the same protection.
const BLOCKED_OR_FAILED_RE =
  /(পারিনি|পারি\s*নি|পারছি\s*না|সম্ভব\s*(?:হয়নি|হয়নি|নয়|নয়)|ব্যর্থ|অফলাইন|সংযোগহীন|সংযোগ\s*(?:নেই|পাওয়া\s*যায়নি|পাওয়া\s*যায়নি)|অনুমতি\s*(?:নেই|লাগবে)|লগইন\s*(?:করুন|লাগবে)|captcha|otp|offline|failed|failure|error|cannot|can't|could\s*not|unavailable|not\s*available|not\s*connected|pairing\s*(?:required|needed))/i

const ADAPTER_INTENT_RE =
  /(করা\s*হবে|করব(ো)?(?![ঀ-ৼ])|করে\s*দিচ্ছি|করে\s*দেব|নির্বাচন\s*কর|সিলেক্ট\s*কর(ব|ছি|া\s*হবে)|ক্লিক\s*কর(ব|ছি|া\s*হবে)|পরের\s*ধাপে|খুলছি|খুলব(?![ঀ-ৼ])|খুলে\s*দিচ্ছ|যাচ্ছি|চালাচ্ছি|শুরু\s*কর(ছি|ব)(?![ঀ-ৼ])|চেষ্টা\s*কর(ছি|ব)(?![ঀ-ৼ])|নেভিগেট\s*কর|ওপেন\s*কর|দেখি(?![ঀ-ৼ])|দেখছি|দেখে\s*নিচ্ছি|দেখব(?![ঀ-ৼ])|স্ক্র(ো|)ল\s*কর|খুঁজ(ছি|ব)|opening\s|navigating\s|scrolling\s|let me\s|i('|’)?ll\s|now i (will|am)|going to\s)/i

const ZERO_TOOL_INTENT_RE =
  /(দিয়ে\s*দেখি|করে\s*দেখি|চেক\s*কর(ি|ছি)|দেখে\s*নিই|দেখে\s*নি|বের\s*কর(ি|ছি)|চালাই|চালাচ্ছি|টান(ি|ছি)|আনছি|আগে.*দেখি|let me (check|look|see|pull|run|fetch)|i('|’)?ll (check|look|see|pull|run|fetch|grab)|i will (check|look|see|pull|run|fetch)|going to (check|look|run|pull|fetch)|let's (check|look|run|see))/i

function isTerminalReply(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return true
  return OWNER_QUESTION_TAIL_RE.test(normalized) || BLOCKED_OR_FAILED_RE.test(normalized)
}

export function shouldNudgeAdapterIntent(input: {
  text: string
  toolRecords: TurnLoopToolRecord[]
  hasAskCard?: boolean
}): boolean {
  if (input.hasAskCard || isTerminalReply(input.text)) return false
  const latestTool = input.toolRecords.at(-1)
  if (latestTool?.status === 'error') return false
  return ADAPTER_INTENT_RE.test(input.text.trim().slice(-600))
}

export function shouldNudgeZeroToolIntent(input: {
  text: string
  hasAskCard?: boolean
}): boolean {
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
