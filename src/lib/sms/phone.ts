export function normalizeSmsPhone(value: unknown): string | null {
  const digits = String(value || '').replace(/\D/g, '')
  if (/^01[3-9]\d{8}$/.test(digits)) return `88${digits}`
  if (/^8801[3-9]\d{8}$/.test(digits)) return digits
  return null
}

export function assertSmsPhone(value: unknown): string {
  const phone = normalizeSmsPhone(value)
  if (!phone) throw new Error('Invalid Bangladesh mobile number.')
  return phone
}
