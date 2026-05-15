import type { InvoicePdfModel } from '@/lib/pdf/types'
import { fetchLogoDataUrl } from '@/lib/pdf/branding'
import { buildPaymentQrDataUrl, qrPayloadFromBranding } from '@/lib/pdf/qr'
import { sanitizePdfModel } from '@/lib/pdf/sanitize'
import { stripPdfAssets } from '@/lib/pdf/assets'
import { pdfSafeMode, PDF_ENRICH_TIMEOUT_MS, PDF_LOGO_TIMEOUT_MS } from '@/lib/pdf/config'
import { pdfDebug, pdfDebugError } from '@/lib/pdf/debug'
import { withTimeout } from '@/lib/pdf/timeout'

async function enrichFull(model: InvoicePdfModel): Promise<InvoicePdfModel> {
  const base = sanitizePdfModel(model)
  pdfDebug('step 2: enrich — invoice data ready', { invoiceId: base.invoiceId })

  let logoDataUrl = base.branding.logoDataUrl
  if (!logoDataUrl?.startsWith('data:') && base.branding.logoUrl) {
    try {
      logoDataUrl = await withTimeout(
        fetchLogoDataUrl(base.branding.logoUrl),
        PDF_LOGO_TIMEOUT_MS,
        'logo fetch',
      )
      pdfDebug('step 3: logo loaded', { ok: !!logoDataUrl })
    } catch (err) {
      pdfDebugError('step 3: logo skipped', err)
      logoDataUrl = undefined
    }
  } else {
    pdfDebug('step 3: logo skipped (none or already data URL)')
  }

  let qrDataUrl: string | undefined
  try {
    qrDataUrl = await withTimeout(
      buildPaymentQrDataUrl(
        qrPayloadFromBranding(base.branding.phone, base.branding.email, base.invoiceId),
      ),
      1500,
      'QR generation',
    )
    pdfDebug('step 4: QR generated', { ok: !!qrDataUrl })
  } catch (err) {
    pdfDebugError('step 4: QR skipped', err)
    qrDataUrl = undefined
  }

  return sanitizePdfModel({
    ...base,
    branding: { ...base.branding, logoDataUrl: logoDataUrl || undefined },
    qrDataUrl,
  })
}

export async function enrichPdfModel(model: InvoicePdfModel): Promise<InvoicePdfModel> {
  pdfDebug('step 1: invoice data loaded', { invoiceId: model.invoiceId })

  if (pdfSafeMode()) {
    pdfDebug('safe mode: skip logo, QR, remote fonts')
    return stripPdfAssets(sanitizePdfModel(model))
  }

  try {
    return await withTimeout(enrichFull(model), PDF_ENRICH_TIMEOUT_MS, 'invoice enrich')
  } catch (err) {
    pdfDebugError('enrich timeout — using minimal model', err)
    return stripPdfAssets(sanitizePdfModel(model))
  }
}
