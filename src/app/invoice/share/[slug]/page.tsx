'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { PdfPreviewModal } from '@/components/pdf/PdfPreviewModal'
import { orderToPdfModel, cditInvoiceToPdfModel } from '@/lib/pdf/models'
import type { InvoicePdfModel } from '@/lib/pdf/types'
import type { Order } from '@/types'
import type { CditInvoice, CditPayment } from '@/types/cdit'
import type { BusinessBranding } from '@/types/branding'
import { Skeleton } from '@/components/ui'

export default function PublicInvoiceSharePage() {
  const params = useParams()
  const slug = String(params.slug || '')
  const [baseModel, setBaseModel] = useState<InvoicePdfModel | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!slug) return
    fetch(`/api/invoice/public/${encodeURIComponent(slug)}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setError(data.error); return }
        if (data.type === 'alma') {
          const order = data.order as Order
          const branding = data.branding as BusinessBranding
          setBaseModel(orderToPdfModel(order, branding, undefined, order.invoice_num))
          return
        }
        const inv = data.invoice as CditInvoice
        const payments = (data.payments || []) as CditPayment[]
        const branding = data.branding as BusinessBranding
        setBaseModel(cditInvoiceToPdfModel(inv, payments, branding))
      })
      .catch(() => setError('Could not load invoice'))
  }, [slug])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-zinc-500 p-8">
        {error}
      </div>
    )
  }

  if (!baseModel) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black p-8">
        <Skeleton className="h-12 w-48" />
      </div>
    )
  }

  return (
    <PdfPreviewModal
      open
      onClose={() => window.history.back()}
      baseModel={baseModel}
      shareSlug={slug}
    />
  )
}
