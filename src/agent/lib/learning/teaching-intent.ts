/**
 * Detect when the owner is teaching a preference/rule (not just chatting).
 */
export type TeachingDomain = 'content' | 'ads' | 'staff' | 'personal' | 'design' | 'pricing' | 'customer' | 'ops'

export type TeachingIntent = {
  ruleText: string
  domain: TeachingDomain
  rawText: string
}

const TEACHING_PATTERNS: RegExp[] = [
  /(?:মনে\s*রাখ|remember|এখন\s*থেকে|from\s*now\s*on|always|never|কখনো\s*না|এভাবে\s*কর(?:বে|ো)\s*না|do\s*not|don't|dont)/i,
  /(?:আমি\s*.+?\s*পছন্দ\s*কর|i\s*prefer|i\s*like|i\s*want\s*you\s*to)/i,
  /(?:ভুল\s*হ(?:য়|oy)েছে|wrong|correction|ঠিক\s*নয়|fix\s*this)/i,
  /(?:নিয়ম\s*হ(?:িস|is)ebe|rule\s*হ(?:িস|is)ebe|এটা\s*নিয়ম)/i,
]

const BLOCKED_RULE = /(?:auto[\s-]?post|approval\s*skip|verify\s*skip|মিথ্যা|lie\s*to|ignore\s*safety|haram|without\s*approve|অনুমোদন\s*ছাড়া)/i

export function isBlockedTeachingRule(ruleText: string): boolean {
  return BLOCKED_RULE.test(ruleText)
}

function extractRuleText(text: string): string {
  const t = text.trim()
  const afterColon = t.match(/(?:মনে\s*রাখ(?:ো|ুন)|এখন\s*থেকে|remember|from\s*now\s*on)[:\s—-]+(.+)/i)
  if (afterColon?.[1]) return afterColon[1].trim().slice(0, 400)
  if (t.length <= 280) return t
  return t.slice(0, 280).trim()
}

export function inferTeachingDomain(text: string): TeachingDomain {
  const t = text.toLowerCase()
  if (/creative|ছবি|background|studio|light|composition|design|রিল|reel|post|content|gate|model|pose|crop|theme|ফটো|poster/i.test(t)) {
    return 'design'
  }
  if (/ad|campaign|meta|boost|roas|creative\s*test|অ্যাড/i.test(t)) return 'ads'
  if (/staff|টাস্ক|dispatch|স্টাফ|eyafi|mustahid/i.test(t)) return 'staff'
  if (/price|pricing|দাম|margin|discount/i.test(t)) return 'pricing'
  if (/customer|messenger|cs|কাস্টমার/i.test(t)) return 'customer'
  if (/personal|family|পার্সনাল/i.test(t)) return 'personal'
  if (/content|facebook|fb|post|caption/i.test(t)) return 'content'
  return 'content'
}

export function detectTeachingIntent(text: string): TeachingIntent | null {
  const trimmed = text.trim()
  if (trimmed.length < 8) return null
  if (!TEACHING_PATTERNS.some((p) => p.test(trimmed))) return null

  const ruleText = extractRuleText(trimmed)
  if (ruleText.length < 6) return null
  if (isBlockedTeachingRule(ruleText)) return null

  return {
    ruleText,
    domain: inferTeachingDomain(trimmed),
    rawText: trimmed,
  }
}
