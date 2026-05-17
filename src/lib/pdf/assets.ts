import type { InvoicePdfModel } from '@/lib/pdf/types'

/** Remove remote/async assets so react-pdf never blocks on image/font fetch. */
export function stripPdfAssets(model: InvoicePdfModel): InvoicePdfModel {
  return {
    ...model,
    qrDataUrl: undefined,
    branding: {
      ...model.branding,
      logoUrl: '',
      // Data URLs are already resolved and do not trigger react-pdf network fetches.
      logoDataUrl: model.branding.logoDataUrl,
    },
  }
}
