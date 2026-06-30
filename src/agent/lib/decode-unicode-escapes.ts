/**
 * Decode literal JS-style `\uXXXX` unicode escape sequences back into real
 * characters — for confirm-card summaries on their way to the owner's screen.
 *
 * WHY THIS EXISTS (root cause):
 * A confirm-card summary is built in code from a real-emoji string literal (e.g.
 * `'🎯 রিটার্গেটিং ...'`) and written to `agent_pending_actions.summary` via Prisma.
 * Prisma/`JSON.stringify` never ASCII-escape astral characters, so that write path
 * always stores the real emoji. But a summary that ever passes through a MODEL
 * (a relayed/delegated worker re-emitting the text) comes back ASCII-escaped, and
 * — tellingly — with UPPERCASE hex (`🎯`), a signature JavaScript itself
 * never produces. Such a value renders literally in the card UI as `🎯`
 * instead of 🎯 (a single leading astral/surrogate-pair emoji is the visible case;
 * BMP emoji like ✅ are unaffected because they need no surrogate pair).
 *
 * This normalizer is applied at the server→client boundary for card summaries so
 * the owner always sees the real glyph. It RESTORES the character (it does not
 * strip it): adjacent decoded surrogate halves (`\uD83C` + `\uDFAF`) naturally
 * recombine into the astral code point because JS strings are UTF-16. It is
 * idempotent (a real emoji contains no `\u` escape, so re-running is a no-op) and
 * leaves any text without a `\uXXXX` sequence completely untouched.
 */
const UNICODE_ESCAPE = /\\u([0-9a-fA-F]{4})/g

export function decodeUnicodeEscapes(input: string): string {
  // Fast path: the overwhelmingly common case is clean text with no escape at all.
  if (typeof input !== 'string' || !input.includes('\\u')) return input
  return input.replace(UNICODE_ESCAPE, (_match, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
}
