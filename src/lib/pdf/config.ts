/** Safe mode: Helvetica only, no remote fonts/logo/QR (prevents infinite PDF hangs). */
export function pdfSafeMode(): boolean {
  if (typeof window !== 'undefined') {
    try {
      const override = localStorage.getItem('alma_pdf_safe')
      if (override === '0') return false
      if (override === '1') return true
    } catch {
      /* ignore */
    }
  }
  return process.env.NEXT_PUBLIC_PDF_SAFE_MODE !== 'false'
}

export const PDF_GENERATE_TIMEOUT_MS = 12000
export const PDF_ENRICH_TIMEOUT_MS = 3000
export const PDF_FONT_TIMEOUT_MS = 2000
export const PDF_LOGO_TIMEOUT_MS = 1500
