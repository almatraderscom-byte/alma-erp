/**
 * Shared Bangla text normalization for the agent's deterministic understanding
 * layer (intent regexes, phone parsing, time parsing).
 *
 * Voice transcripts (gpt-4o-transcribe) and the owner's typed Bangla routinely
 * carry Bangla numerals (০-৯). Every regex in the deterministic layer works on
 * ASCII digits, so this is the single conversion point — call it FIRST.
 */

const BN_DIGITS = '০১২৩৪৫৬৭৮৯'

/** Convert Bangla numerals (০-৯) to ASCII digits; everything else untouched. */
export function bnDigitsToAscii(text: string): string {
  return (text || '').replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)))
}

/**
 * Boundary guards for Bangla/Banglish word matching. JS `\b` only understands
 * ASCII, so "কল" happily matches inside "সকল"/"নকল" and "cal" inside "local"
 * without these. Use as: `(?<!${B_L})(?:call|কল)(?!${B_R})`.
 */
export const B_L = '[a-z\\u0980-\\u09FF]' // guard char class — letter before
export const B_R = '[a-z\\u0980-\\u09FF]' // guard char class — letter after
