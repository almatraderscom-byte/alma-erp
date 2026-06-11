/**
 * Redact sensitive content from worker logs (customer messages, finance amounts).
 */

const AMOUNT_RE = /(?:৳|BDT|Tk\.?|amount|balance|expense|ledger)[:\s]*[\d,]+(?:\.\d+)?/gi

export function safeLogMessage(label, text) {
  if (!text || typeof text !== 'string') {
    console.log(label, text)
    return
  }
  const redacted = text
    .replace(AMOUNT_RE, '[amount-redacted]')
    .slice(0, 200)
  console.log(label, redacted.length < text.length ? `${redacted}…` : redacted)
}
