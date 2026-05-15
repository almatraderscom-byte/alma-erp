/** Enable via localStorage: localStorage.setItem('alma_pdf_debug', '1') */
export function pdfDebugEnabled(): boolean {
  if (typeof window === 'undefined') return process.env.NODE_ENV === 'development'
  try {
    return process.env.NODE_ENV === 'development' || localStorage.getItem('alma_pdf_debug') === '1'
  } catch {
    return process.env.NODE_ENV === 'development'
  }
}

export function pdfDebug(label: string, data?: unknown): void {
  if (!pdfDebugEnabled()) return
  if (data !== undefined) {
    console.log(`[AlmaPDF] ${label}`, data)
  } else {
    console.log(`[AlmaPDF] ${label}`)
  }
}

export function pdfDebugError(label: string, err: unknown): void {
  console.error(`[AlmaPDF] ${label}`, err)
  if (pdfDebugEnabled() && err instanceof Error) {
    console.error(`[AlmaPDF] stack`, err.stack)
  }
}
