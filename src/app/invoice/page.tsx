'use client'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useOrders } from '@/hooks/useERP'
import { PageHeader, Card, StatusBadge, Button, SearchInput, Skeleton, Empty, Money, BdtText } from '@/components/ui'
import { fmt } from '@/lib/utils'
import { api, APIError } from '@/lib/api'
import toast from 'react-hot-toast'
import type { Order } from '@/types'
import { useBranding } from '@/contexts/BrandingContext'
import { useBusiness } from '@/contexts/BusinessContext'
import { PdfPreviewModal } from '@/components/pdf/PdfPreviewModal'
import { orderToPdfModel } from '@/lib/pdf/models'
import { shareSlugAlma } from '@/lib/pdf/format'
import type { InvoicePdfModel } from '@/lib/pdf/types'
import type { BusinessBranding } from '@/types/branding'
import { defaultBusinessBranding, readCachedBranding } from '@/lib/branding-defaults'
import { fetchLogoDataUrl } from '@/lib/pdf/branding'
import { withTimeout } from '@/lib/pdf/timeout'

const INVOICE_READY_TIMEOUT_MS = 5000

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function preloadImage(url?: string) {
  if (!url || typeof window === 'undefined') return Promise.resolve(false)
  return new Promise<boolean>(resolve => {
    const img = new Image()
    const done = (ok: boolean) => resolve(ok)
    img.onload = () => done(true)
    img.onerror = () => done(false)
    img.decoding = 'async'
    img.src = url
  })
}

export default function InvoicePage() {
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Order | null>(null)
  const [pdfModel, setPdfModel] = useState<InvoicePdfModel | null>(null)
  const [genLoading, setGenLoading] = useState(false)
  const [isBrandReady, setIsBrandReady] = useState(false)
  const [isInvoiceReady, setIsInvoiceReady] = useState(false)
  const [isPdfReady, setIsPdfReady] = useState(false)
  const [prepLoading, setPrepLoading] = useState(false)
  const openGuardRef = useRef(0)
  const { business } = useBusiness()
  const { branding, loading: brandingLoading, refetch: refetchBranding } = useBranding()
  const { data, loading, refetch: refetchOrders } = useOrders({ status: 'Delivered' })

  const orders = (data?.orders ?? []).filter(o =>
    !search || [o.id, o.customer, o.product].some(v => v.toLowerCase().includes(search.toLowerCase()))
  )

  const invoiced = orders.filter(o => o.invoice_num)
  const uninvoiced = orders.filter(o => !o.invoice_num)

  const liveOrFallbackBranding = useCallback(async (): Promise<{ branding: BusinessBranding; logoDataUrl?: string; source: 'live' | 'cached' | 'default' }> => {
    if (branding) {
      const logoDataUrl = await withTimeout(fetchLogoDataUrl(branding.logo_url), 1500, 'logo preload').catch(() => undefined)
      await Promise.all([preloadImage(branding.logo_url), preloadImage(branding.favicon_url)])
      return { branding, logoDataUrl, source: 'live' }
    }

    const cached = readCachedBranding(business.id)
    if (cached) {
      const logoDataUrl = await withTimeout(fetchLogoDataUrl(cached.logo_url), 1500, 'cached logo preload').catch(() => undefined)
      await Promise.all([preloadImage(cached.logo_url), preloadImage(cached.favicon_url)])
      return { branding: cached, logoDataUrl, source: 'cached' }
    }

    return { branding: defaultBusinessBranding(business.id), source: 'default' }
  }, [branding, business.id])

  async function waitForBrandingOnce() {
    if (branding) return
    await Promise.race([refetchBranding(), delay(INVOICE_READY_TIMEOUT_MS)])
  }

  async function openPreview(order: Order) {
    const guard = ++openGuardRef.current
    setPrepLoading(true)
    setPreview(order)
    setPdfModel(null)
    setIsBrandReady(false)
    setIsInvoiceReady(false)
    setIsPdfReady(false)

    try {
      await waitForBrandingOnce()
      if (guard !== openGuardRef.current) return

      let resolved = await liveOrFallbackBranding()
      if (brandingLoading && resolved.source === 'default') {
        await Promise.race([refetchBranding(), delay(750)])
        resolved = await liveOrFallbackBranding()
      }
      if (guard !== openGuardRef.current) return

      setIsBrandReady(true)
      setIsInvoiceReady(Boolean(order?.id && order?.customer && order?.product))

      const model = orderToPdfModel(order, resolved.branding, resolved.logoDataUrl, order.invoice_num || undefined)
      setPdfModel(model)
      setIsPdfReady(true)

      if (resolved.source === 'default') {
        console.warn('[invoice-preview] using default branding fallback', { orderId: order.id, businessId: business.id })
      }
    } catch (e) {
      console.error('[invoice-preview] prepare failed; using default branding fallback', e)
      if (guard !== openGuardRef.current) return
      setIsBrandReady(true)
      setIsInvoiceReady(Boolean(order?.id))
      setPdfModel(orderToPdfModel(order, defaultBusinessBranding(business.id), undefined, order.invoice_num || undefined))
      setIsPdfReady(true)
    } finally {
      if (guard === openGuardRef.current) setPrepLoading(false)
    }
  }

  const readinessText = useMemo(() => {
    if (!prepLoading && !preview) return ''
    if (isPdfReady) return 'PDF ready'
    if (isBrandReady && isInvoiceReady) return 'Preparing PDF'
    if (isInvoiceReady) return 'Loading brand'
    return 'Preparing invoice'
  }, [isBrandReady, isInvoiceReady, isPdfReady, prepLoading, preview])

  async function handleSaveToDrive() {
    if (!preview) return
    setGenLoading(true)
    try {
      const r = await api.mutations.generateInvoice(preview.id)
      if (r?.ok) {
        toast.success(`Backed up to Drive: ${r.invoice_number || ''}`)
        refetchOrders()
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
        open={!!preview}
        onClose={() => { openGuardRef.current += 1; setPreview(null); setPdfModel(null); setPrepLoading(false); setIsPdfReady(false) }}
        baseModel={pdfModel}
        shareSlug={preview ? shareSlugAlma(preview.id) : undefined}
        onSaveToDrive={handleSaveToDrive}
        saveToDriveLoading={genLoading}
        externalLoading={prepLoading}
        readinessLabel={readinessText}
      />
    </>
  )
}
