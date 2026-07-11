/**
 * Staff-facing messages must sound like ALMA team coordination — not the owner's personal orders.
 */
import { enforceIslamicGreeting } from '@/agent/lib/islamic-greeting'

const OWNER_PROXY_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /(?:মালিক|Maruf|Boss|Boss|দোলার|Doler|owner).{0,30}(?:বলেছেন|বলেছে|নির্দেশ|আদেশ|চান|চায়|জন্য|jonno)/gi, replacement: 'ALMA টিম' },
  { pattern: /(?:তোমার|আপনার)\s+দোষ/gi, replacement: 'আমাদের টিম স্ট্যান্ডার্ড' },
  { pattern: /দোলার\s+জন্য\s+দায়িত্ব/gi, replacement: 'ALMA টিমের দায়িত্ব' },
  { pattern: /মালিকের\s+পক্ষ\s+থেকে/gi, replacement: 'ALMA টিমের পক্ষ থেকে' },
]

export function enforceAlmaTeamVoice(text: string): string {
  let out = String(text ?? '').trim()
  if (!out) return out
  for (const { pattern, replacement } of OWNER_PROXY_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  if (!/ALMA\s*টিম|আমাদের\s*টিম/i.test(out) && out.length > 40) {
    out = `${out}\n\n— ALMA টিম`
  }
  return out
}

export function prepareStaffOutboundMessage(text: string): string {
  return enforceAlmaTeamVoice(enforceIslamicGreeting(text))
}
