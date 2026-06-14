/** Block non-Islamic greetings in staff Telegram messages. */
const BANNED = [
  [/নমস্কার/gi, 'আসসালামু আলাইকুম'],
  [/nomoshkar/gi, 'আসসালামু আলাইকুম'],
  [/namaskar/gi, 'আসসালামু আলাইকুম'],
  [/namaste/gi, 'আসসালামু আলাইকুম'],
  [/নমস্তে/gi, 'আসসালামু আলাইকুম'],
  [/^(hello|hi)\b/gi, 'আসসালামু আলাইকুম'],
]

export function enforceIslamicGreeting(text) {
  let out = String(text ?? '')
  for (const [re, rep] of BANNED) {
    out = out.replace(re, rep)
  }
  return out.replace(/(আসসালামু আলাইকুম\s*){2,}/gi, 'আসসালামু আলাইকুম ')
}
