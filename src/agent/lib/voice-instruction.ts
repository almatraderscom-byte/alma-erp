/**
 * PA-3 voice → execution shared constants. Lives outside the route file because
 * Next.js route modules may only export HTTP handlers/config (typegen enforces it).
 */

/** Marker prefix the head prompt documents — makes the origin visible in chat (PA-4). */
export const VOICE_INSTRUCTION_PREFIX = '🎙️ [ভয়েস কল থেকে নির্দেশ]'
