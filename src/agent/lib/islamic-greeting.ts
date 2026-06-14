/** Block non-Islamic greetings in owner/staff-facing Bangla text. */
const BANNED_GREETING_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /নমস্কার/gi, replacement: 'আসসালামু আলাইকুম' },
  { pattern: /nomoshkar/gi, replacement: 'আসসালামু আলাইকুম' },
  { pattern: /namaskar/gi, replacement: 'আসসালামু আলাইকুম' },
  { pattern: /namaste/gi, replacement: 'আসসালামু আলাইকুম' },
  { pattern: /নমস্তে/gi, replacement: 'আসসালামু আলাইকুম' },
  { pattern: /^(hello|hi)\b/gi, replacement: 'আসসালামু আলাইকুম' },
]

export function enforceIslamicGreeting(text: string): string {
  let out = text
  for (const { pattern, replacement } of BANNED_GREETING_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out.replace(/(আসসালামু আলাইকুম\s*){2,}/gi, 'আসসালামু আলাইকুম ')
}
