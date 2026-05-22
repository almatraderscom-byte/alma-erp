import { BDT_SYMBOL } from '@/lib/currency'

/** PDF-safe currency prefix — use BDT text when Bengali font is unavailable. */
export type PdfCurrencyMode = 'bdt' | 'symbol'

export function pdfMoney(n: number, mode: PdfCurrencyMode = 'bdt'): string {
  const value = Number(n || 0)
  const hasDecimals = Math.abs(value % 1) > 0
  const formatted = value.toLocaleString('en-BD', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  })
  const prefix = mode === 'symbol' ? BDT_SYMBOL : 'BDT '
  return `${prefix}${formatted}`
}

export function pdfDate(s: string): string {
  if (!s) return '—'
  return s.length > 10 ? s.slice(0, 10) : s
}

export function shareSlugAlma(orderId: string): string {
  return `alma-${encodeURIComponent(orderId)}`
}

export function shareSlugCdit(invoiceId: string): string {
  return `cdit-${encodeURIComponent(invoiceId)}`
}

export function parseShareSlug(slug: string): { type: 'alma' | 'cdit'; id: string } | null {
  if (slug.startsWith('alma-')) return { type: 'alma', id: decodeURIComponent(slug.slice(5)) }
  if (slug.startsWith('cdit-')) return { type: 'cdit', id: decodeURIComponent(slug.slice(5)) }
  return null
}

export function publicShareUrl(slug: string): string {
  if (typeof window === 'undefined') return `/invoice/share/${slug}`
  return `${window.location.origin}/invoice/share/${slug}`
}
