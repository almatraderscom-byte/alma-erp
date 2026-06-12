/** Normalize Bangladesh / E.164 phone for Twilio outbound. */
export function normalizeOutboundPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '')
  if (!digits) return null

  if (digits.startsWith('+')) {
    const n = '+' + digits.slice(1).replace(/\D/g, '')
    return n.length >= 10 ? n : null
  }

  const d = digits.replace(/\D/g, '')
  if (d.startsWith('880') && d.length >= 12) return `+${d}`
  if (d.startsWith('01') && d.length === 11) return `+88${d}`
  if (d.startsWith('1') && d.length === 10) return `+880${d}`
  return null
}
