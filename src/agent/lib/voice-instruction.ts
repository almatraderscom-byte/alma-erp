/**
 * PA-3 voice → execution shared constants. Lives outside the route file because
 * Next.js route modules may only export HTTP handlers/config (typegen enforces it).
 */

/** Marker prefix the head prompt documents — makes the origin visible in chat (PA-4). */
export const VOICE_INSTRUCTION_PREFIX = '🎙️ [ভয়েস কল থেকে নির্দেশ]'

/** True when a (user-role) chat message is a boss instruction relayed from a live call. */
export function isVoiceInstructionText(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(VOICE_INSTRUCTION_PREFIX)
}

/**
 * The instruction body without the marker — what the boss actually said.
 *
 * Safe on ANY text: non-prefixed input comes back unchanged (the head-router
 * calls this on every turn). Routing hygiene matters here because the marker
 * contains the standalone word "কল" — next to an ordinary say-verb in the task
 * ("...বলো/জানাও") it tripped the outbound-call-intent detector and forced
 * EVERY voice instruction onto the heavy head (owner 2026-07-24). The emoji is
 * optional so a client that drops it still gets stripped.
 */
export function stripVoiceInstructionPrefix(text: string): string {
  return text
    .replace(/^\s*(?:🎙️\s*)?\[ভয়েস কল থেকে নির্দেশ\]\s*/u, '')
    .trim()
}

/**
 * PA-5R precision (live complaint 2026-07-24): the boss asked for a sales
 * update in the APP's voice session — got the answer AND an unwanted phone
 * call, because the model imitated earlier callback turns in the history. A
 * report CALL is only legitimate when the boss himself said so with
 * call-words. This regex is the server-side arbiter — call_boss_with_report is
 * blocked unless the boss's own recent words match: কল/ফোন করে জানাও-জানিও-
 * জানাবে, call kore janabi, কল দিবে/দিও…
 */
const CALLBACK_REQUEST_RE =
  /(?:কল|ফোন|call|fon|kol)\s*(?:করে|কোরে|kore|korey)[^\n।?]{0,24}?(?:জানা|জানি|jana|jani)|(?:কল|ফোন)\s*(?:দাও|দিও|দিবে|দিস|করবে)|(?:call|kol|fon)\s*(?:dio|dibi|dibe|daw|dao)/i

/** True when any of the boss's recent messages explicitly asked for a report CALL. */
export function ownerRequestedCallback(recentUserTexts: readonly string[]): boolean {
  return recentUserTexts.slice(-6).some((t) => CALLBACK_REQUEST_RE.test(t || ''))
}
