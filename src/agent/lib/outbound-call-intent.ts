/**
 * Outbound-call intent detection.
 *
 * The owner repeatedly hit a bug where "tumi oi nambare call kore bolo …" (place a
 * phone call to someone and say X) was NOT recognised as a call. Two things hijacked it:
 *   1. The head-router triaged it as a "simple reminder" → cheap DeepSeek head, which
 *      answered with a "45-minute reminder" instead of dialing.
 *   2. The evening owner-task-intake captured it as "tomorrow's tasks".
 *
 * This module detects the intent deterministically so the call request can: (a) force
 * the Sonnet head (an action that dials a real person is high-stakes), and (b) inject a
 * directive that routes it to the `outbound_phone_call` tool — never a reminder/todo.
 * It is intentionally precision-biased: a calling verb alone is not enough; it must be
 * paired with a "say/tell" verb, a phone number, or the word "number/নাম্বার".
 */

// A verb of calling/phoning (Bangla + Banglish + English).
const CALL_VERB = '(?:call|cal|kl|কল|ফোন|phone|fon|dial|ডায়াল)'
// "say / tell / inform" — the message the agent must relay on the call.
const SAY_VERB =
  '(?:bolbe|bolba|bolo|bol|bola|bole|বলবে|বলবা|বলো|বল|বলে|janabe|janaba|janao|জানাবে|জানাবা|জানিয়ে|জানাও|inform|tell|say)'
// "number / নাম্বার" anchor — used both for routing and to tell whether one is present.
const NUMBER_WORD = '(?:number|nambar|nombor|নাম্বার|নম্বর|নাম্বর)'

// A calling verb that sits near a say-verb or the word "number" → an instruction to the
// agent to phone someone and relay a message. The window keeps it from matching unrelated
// far-apart words.
const CALL_NEAR_SAY = new RegExp(`${CALL_VERB}[^\\n]{0,40}${SAY_VERB}`, 'i')
const SAY_NEAR_CALL = new RegExp(`${SAY_VERB}[^\\n]{0,40}${CALL_VERB}`, 'i')
const CALL_NEAR_NUMBER = new RegExp(`${NUMBER_WORD}[^\\n]{0,40}${CALL_VERB}|${CALL_VERB}[^\\n]{0,40}${NUMBER_WORD}`, 'i')

/** A Bangladesh phone number anywhere in the text (tolerant of spaces / dashes). */
export function textHasBdNumber(text: string): boolean {
  const digits = (text || '').replace(/[^\d]/g, '')
  // +8801XXXXXXXXX (drops the leading 0) or local 01XXXXXXXXX.
  return /8801\d{8,9}/.test(digits) || /(?:^|[^\d])01\d{8,9}/.test(digits)
}

export interface OutboundCallIntent {
  isCall: boolean
  hasNumber: boolean
}

/**
 * True when the owner is instructing the agent to place a phone call to someone and
 * relay a message. Requires a calling verb PLUS (a say-verb OR a number OR the word
 * "number") so a passing "call me later" reminder does not trip it.
 */
export function detectOutboundCallIntent(text: string): OutboundCallIntent {
  const t = (text || '').trim()
  if (!t) return { isCall: false, hasNumber: false }
  const hasNumber = textHasBdNumber(t)
  const isCall =
    CALL_NEAR_SAY.test(t) ||
    SAY_NEAR_CALL.test(t) ||
    CALL_NEAR_NUMBER.test(t) ||
    (hasNumber && new RegExp(CALL_VERB, 'i').test(t))
  return { isCall, hasNumber }
}

/** Convenience boolean for the head-router. */
export function isOutboundCallIntent(text: string): boolean {
  return detectOutboundCallIntent(text).isCall
}

/**
 * Directive injected next to the owner's message so the head routes the request to the
 * outbound_phone_call tool instead of logging a reminder/todo. Handles the common
 * two-message flow (instructions now, the number in the next message).
 */
export function buildOutboundCallIntakeBlock(hasNumber: boolean): string {
  const head =
    '[OUTBOUND CALL REQUEST — ACT, DO NOT LOG]\n' +
    'Sir is instructing YOU to place a phone call to a person and speak a message on his behalf. ' +
    'This is NOT a reminder, NOT a todo, NOT "কালকের কাজ". Do NOT call set_reminder, manage_work_todos, ' +
    'or promise to "remind in X minutes" for this.'
  const withNumber =
    ' A phone number is present in his message → call outbound_phone_call now with that exact number and the ' +
    'EXACT message Sir dictated. If Sir said "ElevenLabs voice / এলেভেনল্যাবস", set ttsProvider=elevenlabs. ' +
    'It makes a confirm card — tell Sir to Approve and it will dial.'
  const withoutNumber =
    ' The number is not in this message yet (Sir said he will send it). Reply in ONE short Bangla line that you ' +
    'are ready and ask him to send the number now; then call outbound_phone_call the moment it arrives with the ' +
    'exact message he dictated (ttsProvider=elevenlabs if he asked for ElevenLabs voice). Do NOT set any reminder ' +
    'while waiting.'
  return head + (hasNumber ? withNumber : withoutNumber)
}
