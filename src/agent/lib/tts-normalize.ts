/**
 * Deterministic pre-TTS text normalizer for the bn-IN Google voice
 * (bn-IN-Chirp3-HD-Charon). The raw model output mixes Bangla prose with ASCII
 * numbers, currency symbols, English brand names and technical acronyms — the
 * bn-IN voice mispronounces all of these. This module rewrites them into
 * spoken-Bangla equivalents BEFORE the text reaches Google TTS so the owner
 * hears "এক হাজার দুইশো পঞ্চাশ টাকা" instead of a garbled "৳1,250".
 *
 * Design contract:
 *  - Never throws. Any internal error returns the input unchanged (a slightly
 *    mispronounced word is always better than a crashed voice reply).
 *  - Idempotent: running the output back through produces the same text. Every
 *    rewrite target is consumed (digits, symbols, ASCII acronyms) so a second
 *    pass finds nothing left to change.
 *  - Pure Bangla prose is left untouched.
 *
 * Number system is the Bangla lakh/crore system: হাজার (10^3), লাখ (10^5),
 * কোটি (10^7). Supported integer range 0 → 99,99,99,999 (< 10 digits); larger
 * groups are read digit-by-digit.
 */

// Complete 0-99 Bangla word table. This is the load-bearing part — the bn
// number words are irregular and must be exact.
const ONES: string[] = [
  'শূন্য',
  'এক',
  'দুই',
  'তিন',
  'চার',
  'পাঁচ',
  'ছয়',
  'সাত',
  'আট',
  'নয়',
  'দশ',
  'এগারো',
  'বারো',
  'তেরো',
  'চৌদ্দ',
  'পনেরো',
  'ষোলো',
  'সতেরো',
  'আঠারো',
  'ঊনিশ',
  'বিশ',
  'একুশ',
  'বাইশ',
  'তেইশ',
  'চব্বিশ',
  'পঁচিশ',
  'ছাব্বিশ',
  'সাতাশ',
  'আটাশ',
  'ঊনত্রিশ',
  'ত্রিশ',
  'একত্রিশ',
  'বত্রিশ',
  'তেত্রিশ',
  'চৌত্রিশ',
  'পঁয়ত্রিশ',
  'ছত্রিশ',
  'সাঁইত্রিশ',
  'আটত্রিশ',
  'ঊনচল্লিশ',
  'চল্লিশ',
  'একচল্লিশ',
  'বিয়াল্লিশ',
  'তেতাল্লিশ',
  'চুয়াল্লিশ',
  'পঁয়তাল্লিশ',
  'ছেচল্লিশ',
  'সাতচল্লিশ',
  'আটচল্লিশ',
  'ঊনপঞ্চাশ',
  'পঞ্চাশ',
  'একান্ন',
  'বাহান্ন',
  'তেপ্পান্ন',
  'চুয়ান্ন',
  'পঞ্চান্ন',
  'ছাপ্পান্ন',
  'সাতান্ন',
  'আটান্ন',
  'ঊনষাট',
  'ষাট',
  'একষট্টি',
  'বাষট্টি',
  'তেষট্টি',
  'চৌষট্টি',
  'পঁয়ষট্টি',
  'ছেষট্টি',
  'সাতষট্টি',
  'আটষট্টি',
  'ঊনসত্তর',
  'সত্তর',
  'একাত্তর',
  'বাহাত্তর',
  'তিয়াত্তর',
  'চুয়াত্তর',
  'পঁচাত্তর',
  'ছিয়াত্তর',
  'সাতাত্তর',
  'আটাত্তর',
  'ঊনআশি',
  'আশি',
  'একাশি',
  'বিরাশি',
  'তিরাশি',
  'চুরাশি',
  'পঁচাশি',
  'ছিয়াশি',
  'সাতাশি',
  'আটাশি',
  'ঊননব্বই',
  'নব্বই',
  'একানব্বই',
  'বিরানব্বই',
  'তিরানব্বই',
  'চুরানব্বই',
  'পঁচানব্বই',
  'ছিয়ানব্বই',
  'সাতানব্বই',
  'আটানব্বই',
  'নিরানব্বই',
]

const BANGLA_DIGITS: string[] = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯']

// Map a single digit char (ASCII or Bangla) to its Bangla word, else null.
function digitWord(ch: string): string | null {
  if (ch >= '0' && ch <= '9') return ONES[ch.charCodeAt(0) - 48]
  const idx = BANGLA_DIGITS.indexOf(ch)
  return idx >= 0 ? ONES[idx] : null
}

// Convert a string of digits to their Bangla words, space-separated.
// Handles both ASCII and Bangla numerals.
function digitsToWords(digits: string): string {
  const out: string[] = []
  for (const ch of digits) {
    const w = digitWord(ch)
    if (w !== null) out.push(w)
  }
  return out.join(' ')
}

// Read a 1-3 digit group (0-999) into Bangla words. Used as the building block
// for the lakh/crore grouping. 0 within a larger number contributes nothing.
function belowThousand(n: number): string {
  const parts: string[] = []
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  if (hundreds > 0) parts.push(ONES[hundreds] + 'শো')
  if (rest > 0) parts.push(ONES[rest])
  return parts.join(' ')
}

/**
 * Convert a non-negative integer 0 → 99,99,99,999 into Bangla words using the
 * lakh/crore system. Callers guarantee the range; out-of-range values fall back
 * to digit-by-digit reading.
 */
function nonNegativeToBanglaWords(n: number): string {
  if (n === 0) return ONES[0]

  const crore = Math.floor(n / 10000000)
  const lakh = Math.floor((n % 10000000) / 100000)
  const thousand = Math.floor((n % 100000) / 1000)
  const rest = n % 1000

  const parts: string[] = []
  if (crore > 0) parts.push(belowThousand(crore) + ' কোটি')
  if (lakh > 0) parts.push(ONES[lakh] + ' লাখ')
  if (thousand > 0) parts.push(ONES[thousand] + ' হাজার')
  if (rest > 0) parts.push(belowThousand(rest))
  return parts.join(' ')
}

/**
 * Public: convert an integer to Bangla words.
 *  - Negatives are prefixed with "মাইনাস".
 *  - Non-integers read the integer part in words, then "দশমিক", then up to two
 *    decimal digits read digit-by-digit.
 *  - Integers of 10 digits or more are read digit-by-digit.
 */
export function numberToBanglaWords(n: number): string {
  try {
    if (typeof n !== 'number' || !isFinite(n)) return String(n)

    const negative = n < 0
    const abs = Math.abs(n)

    const intPart = Math.floor(abs)
    const isDecimal = abs !== intPart

    let intWords: string
    if (intPart >= 1000000000) {
      // 10+ digits: outside lakh/crore range, read digit-by-digit.
      intWords = digitsToWords(String(intPart))
    } else {
      intWords = nonNegativeToBanglaWords(intPart)
    }

    let result = intWords
    if (isDecimal) {
      // Up to two decimal places, digit-by-digit after "দশমিক".
      const decStr = abs.toFixed(2).split('.')[1].replace(/0+$/, '') || '0'
      result = intWords + ' দশমিক ' + digitsToWords(decStr)
    }

    return negative ? 'মাইনাস ' + result : result
  } catch {
    return String(n)
  }
}

// ---------------------------------------------------------------------------
// normalizeForTts
// ---------------------------------------------------------------------------

// Known-term phonetic map. Longer/more-specific keys first so ".com" and
// "almatraders" win before generic tokens. Matched case-insensitively at word
// boundaries (see buildTermRegex).
const TERM_MAP: Array<[string, string]> = [
  ['almatraders', 'আলমাট্রেডার্স'],
  ['.com', ' ডট কম'],
  ['WhatsApp', 'হোয়াটসঅ্যাপ'],
  ['Facebook', 'ফেসবুক'],
  ['Telegram', 'টেলিগ্রাম'],
  ['Instagram', 'ইনস্টাগ্রাম'],
  ['Google', 'গুগল'],
  ['iPhone', 'আইফোন'],
  ['Android', 'অ্যান্ড্রয়েড'],
  ['crypto', 'ক্রিপ্টো'],
  ['Vercel', 'ভার্সেল'],
  ['Okay', 'ওকে'],
  ['ALMA', 'আলমা'],
  ['SUI', 'সুই'],
  ['BTC', 'বিটিসি'],
  ['ETH', 'ইথেরিয়াম'],
  ['OK', 'ওকে'],
  ['Sir', 'স্যার'],
  ['AI', 'এআই'],
  ['API', 'এপিআই'],
  ['URL', 'ইউআরএল'],
  ['TTS', 'টিটিএস'],
]

// Escape a literal string for use inside a RegExp.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Build a case-insensitive matcher for a term. ".com" is a suffix-style token
// (no leading boundary, matches when attached to a word); all others are
// bounded by non-letter/digit edges so "AI" doesn't fire inside "email".
function buildTermRegex(term: string): RegExp {
  if (term.startsWith('.')) {
    return new RegExp(escapeRegex(term), 'gi')
  }
  return new RegExp('(?<![A-Za-z0-9])' + escapeRegex(term) + '(?![A-Za-z0-9])', 'gi')
}

// Parse a numeric literal (ASCII digits, optional commas, optional decimal)
// into a Number. Returns null if not parseable.
function parseNumericLiteral(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null
  const v = Number(cleaned)
  return isFinite(v) ? v : null
}

// Render a numeric literal to spoken Bangla. Integers with 10+ digits (or with
// grouping that yields a huge value) fall to digit-by-digit reading per spec.
function speakNumericLiteral(raw: string): string {
  const cleaned = raw.replace(/,/g, '')
  const num = parseNumericLiteral(raw)
  if (num === null) return raw

  const isInt = !cleaned.includes('.')
  // Standalone integers of more than 9 digits: digit-by-digit.
  if (isInt && cleaned.replace(/^-/, '').length > 9) {
    return digitsToWords(cleaned)
  }
  return numberToBanglaWords(num)
}

export function normalizeForTts(text: string): string {
  try {
    if (typeof text !== 'string' || text.length === 0) return text

    let out = text

    // (a) Currency.
    // Taka symbol prefix: ৳1,250 / ৳1250
    out = out.replace(/৳\s*([\d,]+(?:\.\d+)?)/g, (_m, num: string) => {
      const spoken = speakNumericLiteral(num)
      return spoken + ' টাকা'
    })
    // Trailing "টাকা": 1250 টাকা -> এক হাজার দুইশো পঞ্চাশ টাকা (avoid double word)
    out = out.replace(/([\d,]+(?:\.\d+)?)\s*টাকা/g, (_m, num: string) => {
      const spoken = speakNumericLiteral(num)
      return spoken + ' টাকা'
    })
    // Dollar prefix: $3.42 -> তিন দশমিক চার দুই ডলার
    out = out.replace(/\$\s*([\d,]+(?:\.\d+)?)/g, (_m, num: string) => {
      const spoken = speakNumericLiteral(num)
      return spoken + ' ডলার'
    })

    // (b) Percentages: 4.2% -> চার দশমিক দুই শতাংশ
    out = out.replace(/([\d,]+(?:\.\d+)?)\s*%/g, (_m, num: string) => {
      const spoken = speakNumericLiteral(num)
      return spoken + ' শতাংশ'
    })

    // (e) Phone numbers BEFORE generic digit groups: +8801XXXXXXXXX / 01XXXXXXXXX
    out = out.replace(/\+8801\d{9}\b/g, (m) => digitsToWords(m.replace('+', '')))
    out = out.replace(/(?<!\d)01\d{9}(?!\d)/g, (m) => digitsToWords(m))

    // (f) Time like 4:50 -> চারটা পঞ্চাশ
    out = out.replace(/(?<!\d)([0-2]?\d):([0-5]\d)(?!\d)/g, (_m, h: string, mm: string) => {
      const hour = Number(h)
      const minute = Number(mm)
      const hourWord = numberToBanglaWords(hour) + 'টা'
      const minuteWord = numberToBanglaWords(minute)
      return hourWord + ' ' + minuteWord
    })

    // (c) Standalone digit-groups (ASCII 0-9 and Bangla ০-৯, optional commas).
    out = out.replace(/[\d০-৯][\d০-৯,]*(?:\.[\d০-৯]+)?/g, (m) => {
      // Normalize Bangla numerals to ASCII for parsing.
      const ascii = m.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)))
      const cleaned = ascii.replace(/,/g, '')
      const digitsOnly = cleaned.replace('.', '').replace(/^-/, '')
      if (digitsOnly.length > 9) {
        return digitsToWords(cleaned.replace('.', ''))
      }
      const num = parseNumericLiteral(ascii)
      if (num === null) return m
      return numberToBanglaWords(num)
    })

    // (d) Known-term phonetic map. Applied after numbers so acronyms like "AI"
    // aren't disturbed by numeric rewrites.
    for (const [term, spoken] of TERM_MAP) {
      out = out.replace(buildTermRegex(term), spoken)
    }

    // Collapse any accidental double spaces introduced by substitutions.
    out = out.replace(/[ \t]{2,}/g, ' ')

    return out
  } catch {
    return text
  }
}
