/**
 * PA-3 voice → execution shared constants. Lives outside the route file because
 * Next.js route modules may only export HTTP handlers/config (typegen enforces it).
 */

/** Marker prefix the head prompt documents — makes the origin visible in chat (PA-4). */
export const VOICE_INSTRUCTION_PREFIX = '🎙️ [ভয়েস কল থেকে নির্দেশ]'

/**
 * Routing input hygiene: the display prefix contains the standalone word "কল",
 * which combined with an ordinary say-verb in the task ("...বলো/জানাও") tripped
 * the outbound-call-intent detector — EVERY voice instruction got forced onto
 * the heavy head (owner 2026-07-24: "voice always lands on Grok"). Strip the
 * marker (with or without the emoji) before any intent/routing regex runs.
 */
export function stripVoiceInstructionPrefix(text: string): string {
  return text
    .replace(/^\s*(?:🎙️\s*)?\[ভয়েস কল থেকে নির্দেশ\]\s*/u, '')
    .trim()
}
