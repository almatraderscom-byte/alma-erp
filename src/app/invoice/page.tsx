'use client'
import { useState } from 'react'
import { useOrders } from '@/hooks/useERP'
import { PageHeader, Card, StatusBadge, Button, SearchInput, Skeleton, Empty, Money, BdtText } from '@/components/ui'
import { fmt } from '@/lib/utils'
import { api, APIError } from '@/lib/api'
import toast from 'react-hot-toast'
import type { Order } from '@/types'
import { useBranding } from '@/contexts/BrandingContext'
import { PdfPreviewModal } from '@/components/pdf/PdfPreviewModal'
import { orderToPdfModel } from '@/lib/pdf/models'
import { shareSlugAlma } from '@/lib/pdf/format'
import type { InvoicePdfModel } from '@/lib/pdf/types'

export default function InvoicePage() {
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Order | null>(null)
  const [pdfModel, setPdfModel] = useState<InvoicePdfModel | null>(null)
  const [genLoading, setGenLoading] = useState(false)
  const { branding } = useBranding()
  const { data, loading, refetch } = useOrders({ status: 'Delivered' })

  const orders = (data?.orders ?? []).filter(o =>
    !search || [o.id, o.customer, o.product].some(v => v.toLowerCase().includes(search.toLowerCase()))
  )

  const invoiced = orders.filter(o => o.invoice_num)
  const uninvoiced = orders.filter(o => !o.invoice_num)

  function openPreview(order: Order) {
    setPreview(order)
    if (!branding) {
      toast.error('Brand settings still loading — try again in a moment')
      return
    }
    setPdfModel(orderToPdfModel(order, branding, undefined, order.invoice_num || undefined))
  }

  async function handleSaveToDrive() {
    if (!preview) return
    setGenLoading(true)
    try {
      const r = await api.mutations.generateInvoice(preview.id)
      if (r?.ok) {
        toast.success(`Backed up to Drive: ${r.invoice_number || ''}`)
        refetch()
      }
    } catch (e) {
      toast.error(e instanceof APIError ? e.userMessage : (e as Error).message)
    } finally {
      setGenLoading(false)
    }
  }

  return (
    <>
      <PageHeader title="Invoices" subtitle={`${invoiced.length} issued · ${uninvoiced.length} pending`} />

      <div className="p-4 md:p-6 pb-24 md:pb-6 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-cream">{orders.length}</p>
            <p className="text-[10px] text-zinc-500 mt-1">Delivered orders</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-green-400">{invoiced.length}</p>
            <p className="text-[10px] text-zinc-500 mt-1">Invoiced</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-amber-400">{uninvoiced.length}</p>
            <p className="text-[10px] text-zinc-500 mt-1">Pending</p>
          </Card>
        </div>

        <SearchInput value={search} onChange={setSearch} placeholder="Search delivered orders…" />

        {uninvoiced.length > 0 && (
          <div>
            <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-amber-400 mb-2">Pending Invoices</p>
            <div className="space-y-2">
              {uninvoiced.map(o => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => openPreview(o)}
                  className="w-full text-left p-4 flex items-center gap-3 rounded-2xl border border-amber-400/15 hover:border-amber-400/30 transition-colors cursor-pointer bg-card"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-[11px] text-gold font-bold">{o.id}</span>
                      <StatusBadge status={o.status} />
                    </div>
                    <p className="text-sm font-semibold text-cream">{o.customer}</p>
                    <p className="text-[11px] text-zinc-500">{o.product}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-cream"><Money amount={o.sell_price} /></p>
                    <p className="text-[10px] text-zinc-500">{o.date}</p>
                  </div>
                  <Button variant="gold" size="xs">Preview PDF</Button>
                </button>
              ))}
            </div>
          </div>
        )}

        {invoiced.length > 0 && (
          <div>
            <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-green-400 mb-2">Issued Invoices</p>
            <div className="space-y-2">
              {invoiced.map(o => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => openPreview(o)}
                  className="w-full text-left p-4 flex items-center gap-3 rounded-2xl border border-green-400/10 cursor-pointer hover:border-green-400/25 transition-colors bg-card"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-[11px] text-gold font-bold">{o.id}</span>
                      <span className="font-mono text-[10px] text-green-400 font-bold">{o.invoice_num}</span>
                    </div>
                    <p className="text-sm font-semibold text-cream">{o.customer}</p>
                    <p className="text-[11px] text-zinc-500">{o.product}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-cream"><Money amount={o.sell_price} /></p>
                    <span className="text-[10px] text-green-400 font-semibold">View PDF</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {!loading && orders.length === 0 && (
          <Empty icon="◈" title="No delivered orders" desc="Invoices are generated for delivered orders" />
        )}
      </div>

      <PdfPreviewModal
        open={!!preview && !!pdfModel}
        onClose={() => { setPreview(null); setPdfModel(null) }}
        baseModel={pdfModel}
        shareSlug={preview ? shareSlugAlma(preview.id) : undefined}
        onSaveToDrive={handleSaveToDrive}
        saveToDriveLoading={genLoading}
      />
    </>
  )
}
