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

/** The instruction body without the marker — what the boss actually said. */
export function stripVoiceInstructionPrefix(text: string): string {
  return text.trimStart().slice(VOICE_INSTRUCTION_PREFIX.length).trim()
}
