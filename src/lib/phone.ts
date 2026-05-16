export function normalizeBdPhone(raw: string | null | undefined): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  let digits = value.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) digits = `+${digits.slice(1).replace(/\D/g, '')}`
  else digits = digits.replace(/\D/g, '')

  if (digits.startsWith('+880')) return digits
  if (digits.startsWith('880')) return `+${digits}`
  if (digits.startsWith('01') && digits.length === 11) return `+88${digits}`
  if (digits.startsWith('1') && digits.length === 10) return `+880${digits}`
  return digits
}

export function isEmailIdentifier(value: string) {
  return value.includes('@')
}

export function normalizeLoginIdentifier(raw: string | null | undefined) {
  const value = String(raw || '').trim()
  if (!value) return { kind: 'empty' as const, value: '' }
  if (isEmailIdentifier(value)) return { kind: 'email' as const, value: value.toLowerCase() }
  return { kind: 'phone' as const, value: normalizeBdPhone(value) }
}

export function isValidBdPhone(raw: string | null | undefined) {
  const normalized = normalizeBdPhone(raw)
  return /^\+8801\d{9}$/.test(normalized)
}

export function displayBdPhone(raw: string | null | undefined) {
  const normalized = normalizeBdPhone(raw)
  if (!normalized.startsWith('+880') || normalized.length !== 14) return normalized
  return `${normalized.slice(0, 4)} ${normalized.slice(4, 7)} ${normalized.slice(7, 10)} ${normalized.slice(10)}`
}
