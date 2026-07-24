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
