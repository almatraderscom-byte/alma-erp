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
 * the heavy head (an action that dials a real person is high-stakes), and (b) inject a
 * directive that routes it to the right call tool — never a reminder/todo.
 * It is intentionally precision-biased: a calling verb alone is not enough; it must be
 * paired with a "say/tell" verb, a phone number, or the word "number/নাম্বার".
 *
 * Voice-audit hardening (2026-07):
 *   - Bangla numerals (০-৯) are normalised first — STT writes phone numbers that way,
 *     and they were previously invisible to every check here.
 *   - Verbs carry word boundaries — "কল" no longer fires inside "সকল/নকল", "cal" no
 *     longer fires inside "local".
 *   - The intent now also classifies ONE-WAY (announce & hang up → outbound_phone_call)
 *     vs TWO-WAY (converse & report back → place_agent_call), mirroring the system
 *     prompt's decision rule deterministically.
 */
import { bnDigitsToAscii, B_L, B_R } from './bangla-text'

// A verb of calling/phoning (Bangla + Banglish + English), word-bounded.
const CALL_VERB = `(?<!${B_L})(?:call|cal|kl|কল|ফোন|টেলিফোন|phone|telephone|fon|dial|ডায়াল)(?!${B_R})`
// "say / tell / inform" — the message the agent must relay on the call.
const SAY_VERB =
  `(?<!${B_L})(?:bolbe|bolba|bolo|bol|bola|bole|বলবে|বলবা|বলো|বল|বলে|janabe|janaba|janao|জানাবে|জানাবা|জানিয়ে|জানাও|inform|tell|say)`
// "number / নাম্বার" anchor — used both for routing and to tell whether one is present.
const NUMBER_WORD = `(?<!${B_L})(?:number|nambar|nombor|নাম্বার|নম্বর|নাম্বর)(?!${B_R})`

// A calling verb that sits near a say-verb or the word "number" → an instruction to the
// agent to phone someone and relay a message. The window keeps it from matching unrelated
// far-apart words.
const CALL_NEAR_SAY = new RegExp(`${CALL_VERB}[^\\n]{0,40}${SAY_VERB}`, 'i')
const SAY_NEAR_CALL = new RegExp(`${SAY_VERB}[^\\n]{0,40}${CALL_VERB}`, 'i')
const CALL_NEAR_NUMBER = new RegExp(`${NUMBER_WORD}[^\\n]{0,40}${CALL_VERB}|${CALL_VERB}[^\\n]{0,40}${NUMBER_WORD}`, 'i')

// TWO-WAY markers: Boss expects something BACK from the person — ask / find out /
// converse / confirm / report what they said.
const ASK_VERB = new RegExp(
  `জিজ্ঞেস|জিজ্ঞাসা|জেনে\\s*(?:নাও|নিও|নিবে|আসো)|কথা\\s*বল|শুনে\\s*(?:নাও|নিও|জানাও|জানাবে)|কনফার্ম\\s*কর|` +
  `(?<!${B_L})(?:jigges|jiggesh|jigyes|jiggasa|confirm\\s*kor|jene\\s*(?:nao|nio|nibe)|kotha\\s*bol|shune\\s*(?:nao|janao|janabe)|ask|find\\s*out|discuss)`,
  'i')
// ONE-WAY markers: pure announcement — deliver the message and hang up.
const ANNOUNCE_VERB = new RegExp(
  `জানিয়ে\\s*(?:দাও|দিও|দে|দিবে)|বলে\\s*(?:দাও|দিও|দে|দিবে)|` +
  `(?<!${B_L})(?:janiye\\s*(?:dao|dio|de|dibe)|bole\\s*(?:dao|dio|de|dibe)|announce|inform\\s*(?:kore\\s*)?dao)`,
  'i')

/** A Bangladesh phone number anywhere in the text (tolerant of spaces / dashes / Bangla numerals). */
export function textHasBdNumber(text: string): boolean {
  const digits = bnDigitsToAscii(text || '').replace(/[^\d]/g, '')
  // +8801XXXXXXXXX (drops the leading 0) or local 01XXXXXXXXX.
  return /8801\d{8,9}/.test(digits) || /(?:^|[^\d])01\d{8,9}/.test(digits)
}

/** How the call should run — mirrors the system-prompt tool-choice rule. */
export type OutboundCallMode = 'one_way' | 'two_way' | 'unspecified'

export interface OutboundCallIntent {
  isCall: boolean
  hasNumber: boolean
  mode: OutboundCallMode
}

/**
 * True when the owner is instructing the agent to place a phone call to someone and
 * relay a message. Requires a calling verb PLUS (a say-verb OR a number OR the word
 * "number") so a passing "call me later" reminder does not trip it.
 */
export function detectOutboundCallIntent(text: string): OutboundCallIntent {
  const t = bnDigitsToAscii((text || '').trim())
  if (!t) return { isCall: false, hasNumber: false, mode: 'unspecified' }
  const hasNumber = textHasBdNumber(t)
  const isCall =
    CALL_NEAR_SAY.test(t) ||
    SAY_NEAR_CALL.test(t) ||
    CALL_NEAR_NUMBER.test(t) ||
    (hasNumber && new RegExp(CALL_VERB, 'i').test(t))
  // Ask-markers win: "জিজ্ঞেস করে জানিয়ে দাও" is a two-way call whose RESULT is
  // then announced back to Boss — the conversation itself is two-way.
  const mode: OutboundCallMode = !isCall
    ? 'unspecified'
    : ASK_VERB.test(t) ? 'two_way' : ANNOUNCE_VERB.test(t) ? 'one_way' : 'unspecified'
  return { isCall, hasNumber, mode }
}

/** Convenience boolean for the head-router. */
export function isOutboundCallIntent(text: string): boolean {
  return detectOutboundCallIntent(text).isCall
}

/**
 * Directive injected next to the owner's message so the head routes the request to the
 * right call tool instead of logging a reminder/todo. Handles the common
 * two-message flow (instructions now, the number in the next message).
 */
export function buildOutboundCallIntakeBlock(hasNumber: boolean, mode: OutboundCallMode = 'unspecified'): string {
  const head =
    '[OUTBOUND CALL REQUEST — ACT, DO NOT LOG]\n' +
    'Boss is instructing YOU to place a phone call to a person and speak a message on his behalf. ' +
    'This is NOT a reminder, NOT a todo, NOT "কালকের কাজ". Do NOT call set_reminder, manage_work_todos, ' +
    'or promise to "remind in X minutes" for this.'
  const toolLine =
    mode === 'one_way'
      ? ' Boss only wants the message DELIVERED (জানিয়ে দাও/বলে দাও — nothing back) → use outbound_phone_call (one-way).'
      : mode === 'two_way'
        ? ' Boss expects something BACK from the person (জিজ্ঞেস/জেনে নাও/কথা বলো/শুনে জানাও) → use place_agent_call ' +
          '(two-way live conversation with transcript+summary). Do NOT use one-way outbound_phone_call for this.'
        : ' Pick the tool by the rule: pure announcement, nothing expected back → outbound_phone_call (one-way); ' +
          'Boss wants the agent to ask/confirm/hear anything back → place_agent_call (two-way). When unsure, prefer two-way.'
  const withNumber =
    ' A phone number is present in his message → call the chosen call tool now with that exact number and the ' +
    'EXACT message/purpose Boss dictated. If Boss said "ElevenLabs voice / এলেভেনল্যাবস", set ttsProvider=elevenlabs. ' +
    'It makes a confirm card — tell Boss to Approve and it will dial.'
  const withoutNumber =
    ' The number is not in this message yet (Boss said he will send it). Reply in ONE short Bangla line that you ' +
    'are ready and ask him to send the number now; then call the chosen call tool the moment it arrives with the ' +
    'exact message he dictated (ttsProvider=elevenlabs if he asked for ElevenLabs voice). Do NOT set any reminder ' +
    'while waiting.'
  return head + toolLine + (hasNumber ? withNumber : withoutNumber)
}
