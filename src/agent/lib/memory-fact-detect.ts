/** Detect owner messages that likely contain durable facts worth save_memory. */
export const MEMORY_SAVE_NUDGE =
  'বিশ্লেষণ: মালিক কোনো স্থায়ী তথ্য বলেছেন? হলে save_memory কল করুন।'

export function looksLikeDurableFact(text: string): boolean {
  const t = text.trim()
  if (!t || t.length < 6) return false

  if (/মনে\s*রাখ|মনে\s*রেখ|remember\s+this|don't\s+forget|save\s+this/i.test(t)) {
    return true
  }
  if (/\b(supplier|সাপ্লায়ার|vendor|ক্লায়েন্ট|customer|পার্টনার|partner|distributor)\b/i.test(t)) {
    return true
  }
  if (/\+?\d{10,14}/.test(t)) return true
  if (/(০|১|২|৩|৪|৫|৬|৭|৮|৯|\d)[\d,.\s]*(টাকা|taka|৳|AED|USD|usd)/i.test(t)) return true
  if (/\b(ঠিকানা|address|রোড|road|বাড়ি|flat|suite|location)\b/i.test(t)) return true
  if (/\b(পছন্দ|prefer|always|কখনোই না|never|from now|এখন থেকে)\b/i.test(t)) return true
  if (/\b(নতুন|new)\b/i.test(t) && /\b(supplier|সাপ্লায়ার|ক্লায়েন্ট|staff|স্টাফ|rule|নিয়ম|contact)\b/i.test(t)) {
    return true
  }
  return false
}
