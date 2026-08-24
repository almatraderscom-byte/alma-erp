/**
 * An explicit request to operate the owner's paired Chrome is an input modality,
 * not a task procedure. It may therefore compose with a primary skill (SEO,
 * research, support, …) without replacing that skill's instructions.
 */

export const EXPLICIT_CHROME_MODALITY_TOOLS = [
  'live_browser_pair',
  'live_browser_status',
  'live_browser_look',
  'live_browser_act',
] as const

const OWNER_CHROME_RE =
  /(?:\b(?:my|amar|amr)\b|আমার)\s*(?:নিজের\s*)?(?:chrome|ক্রোম|browser|ব্রাউজার)/i

const CHROME_OPERATION_RE =
  /\b(?:use|open|check|inspect|visit|browse|navigate|enter|go|dhuk(?:e|te|o)?|dekho|dekh|khulo|khol)\b|(?:দিয়ে|ব্যবহার|ঢুক|খুল|দেখ|যাও|চেক|ইন্সপেক্ট|পরীক্ষা)/i

// Source-code work can mention the owner's browser while asking for no computer
// use at all. A false positive here would hand a software task a live session.
const SOFTWARE_WORK_RE =
  /\b(?:extension|api|sdk|integration|devtools|source\s*code|codebase|repository|repo|refactor|unit\s*test|typescript|javascript|playwright|puppeteer|webdriver)\b|(?:কোড|রিপোজিটরি|ইন্টিগ্রেশন|এক্সটেনশন)/i

/** High-precision, deterministic classifier for explicit owner-Chrome use. */
export function hasExplicitChromeModality(text: string): boolean {
  const value = text.trim()
  if (!value || SOFTWARE_WORK_RE.test(value)) return false
  return OWNER_CHROME_RE.test(value) && CHROME_OPERATION_RE.test(value)
}
