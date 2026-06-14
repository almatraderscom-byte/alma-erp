/** Staff messages: ALMA team voice — not owner-proxy framing. */
import { enforceIslamicGreeting } from './greeting-sanitize.mjs'

const OWNER_PROXY = [
  [/(?:মালিক|Maruf|Boss|Sir|দোলার|Doler|owner).{0,30}(?:বলেছেন|বলেছে|নির্দেশ|আদেশ|চান|চায়|জন্য|jonno)/gi, 'ALMA টিম'],
  [/(?:তোমার|আপনার)\s+দোষ/gi, 'আমাদের টিম স্ট্যান্ডার্ড'],
  [/দোলার\s+জন্য\s+দায়িত্ব/gi, 'ALMA টিমের দায়িত্ব'],
  [/মালিকের\s+পক্ষ\s+থেকে/gi, 'ALMA টিমের পক্ষ থেকে'],
]

export function enforceAlmaTeamVoice(text) {
  let out = String(text ?? '').trim()
  if (!out) return out
  for (const [re, rep] of OWNER_PROXY) {
    out = out.replace(re, rep)
  }
  if (!/ALMA\s*টিম|আমাদের\s*টিম/i.test(out) && out.length > 40) {
    out = `${out}\n\n— ALMA টিম`
  }
  return out
}

export function prepareStaffOutboundMessage(text) {
  return enforceAlmaTeamVoice(enforceIslamicGreeting(text))
}
