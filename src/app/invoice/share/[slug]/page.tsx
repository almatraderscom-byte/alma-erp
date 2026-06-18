'use client'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

const PdfPreviewModal = dynamic(
  () => import('@/components/pdf/PdfPreviewModal').then(m => m.PdfPreviewModal),
  { ssr: false },
)
import { orderToPdfModel, cditInvoiceToPdfModel } from '@/lib/pdf/models'
import type { InvoicePdfModel } from '@/lib/pdf/types'
import type { Order } from '@/types'
import type { CditInvoice, CditPayment } from '@/types/cdit'
import type { BusinessBranding } from '@/types/branding'
import { Skeleton } from '@/components/ui'
import type { InvoiceRegistryRecord } from '@/lib/api'

export default function PublicInvoiceSharePage() {
  const params = useParams()
  const router = useRouter()
  const slug = String(params.slug || '')
  const [baseModel, setBaseModel] = useState<InvoicePdfModel | null>(null)
  const [open, setOpen] = useState(true)
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
          const invoice = data.invoice as Pick<InvoiceRegistryRecord, 'invoiceNumber' | 'paymentStatus'> | null | undefined
          setBaseModel(orderToPdfModel(order, branding, undefined, invoice?.invoiceNumber || order.invoice_num, { paymentStatus: invoice?.paymentStatus }))
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
      <div className="min-h-screen flex items-center justify-center bg-black text-muted p-8">
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
      open={open}
      onClose={() => {
        setOpen(false)
        if (window.history.length > 1) window.history.back()
        else router.replace('/invoice')
      }}
      baseModel={baseModel}
      shareSlug={slug}
    />
  )
}
