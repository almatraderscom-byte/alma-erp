import QRCode from 'qrcode'

export async function buildPaymentQrDataUrl(payload: string): Promise<string | undefined> {
  if (!payload.trim()) return undefined
  try {
    return await QRCode.toDataURL(payload, { width: 120, margin: 1, color: { dark: '#C9A84C', light: '#0a0a0c' } })
  } catch {
    return undefined
  }
}

export function qrPayloadFromBranding(phone: string, email: string, invoiceId: string): string {
  if (phone) return `tel:${phone.replace(/\s/g, '')}`
  if (email) return `mailto:${email}?subject=Invoice%20${encodeURIComponent(invoiceId)}`
  return invoiceId
}
