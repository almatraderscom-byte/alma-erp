import { pdf } from '@react-pdf/renderer'
import { PremiumInvoiceDocument } from '@/components/pdf/PremiumInvoiceDocument'
import type { InvoicePdfModel } from '@/lib/pdf/types'
import { stripPdfAssets } from '@/lib/pdf/assets'
import { pdfSafeMode, PDF_GENERATE_TIMEOUT_MS } from '@/lib/pdf/config'
import { pdfDebug, pdfDebugError } from '@/lib/pdf/debug'
import { ensurePdfFonts } from '@/lib/pdf/fonts'
import { sanitizePdfModel } from '@/lib/pdf/sanitize'
import { withTimeout } from '@/lib/pdf/timeout'

const MIN_BLOB_BYTES = 512

export type PdfGenerateResult =
  | { ok: true; blob: Blob; model: InvoicePdfModel }
  | { ok: false; error: string; details?: string }

async function renderBlob(model: InvoicePdfModel): Promise<Blob> {
  pdfDebug('step 5: loading fonts')
  await ensurePdfFonts()
  pdfDebug('step 6: fonts ready', { family: pdfSafeMode() ? 'Helvetica' : 'AlmaPDF/Helvetica' })

  const renderModel = pdfSafeMode() ? stripPdfAssets(model) : model

  pdfDebug('step 7: creating PDF document')
  const instance = pdf(<PremiumInvoiceDocument model={renderModel} />)

  pdfDebug('step 8: generating blob…')
  const blob = await instance.toBlob()
  pdfDebug('step 9: blob created', { size: blob.size, type: blob.type })
  return blob
}

export async function generateInvoicePdfBlob(
  rawModel: InvoicePdfModel,
): Promise<PdfGenerateResult> {
  const model = sanitizePdfModel(rawModel)
  pdfDebug('generate start', {
    safeMode: pdfSafeMode(),
    invoiceId: model.invoiceId,
    lineItems: model.lineItems.length,
    total: model.total,
  })

  try {
    const blob = await withTimeout(
      renderBlob(model),
      PDF_GENERATE_TIMEOUT_MS,
      'PDF generation',
    )

    if (!blob || blob.size < MIN_BLOB_BYTES) {
      return {
        ok: false,
        error: 'PDF file was empty or too small',
        details: `size=${blob?.size ?? 0}`,
      }
    }

    pdfDebug('step 10: blob validated')
    return { ok: true, blob, model }
  } catch (err) {
    pdfDebugError('generate failed', err)
    const message =
      err instanceof Error && err.name === 'PdfTimeoutError'
        ? 'PDF generation took too long. Try Retry or enable debug logs.'
        : err instanceof Error
          ? err.message
          : 'PDF generation failed'
    return {
      ok: false,
      error: message,
      details: err instanceof Error ? err.stack : undefined,
    }
  }
}
