'use client'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOrders } from '@/hooks/useERP'
import { PageHeader, Card, StatusBadge, Button, SearchInput, Skeleton, Empty, Money, Select } from '@/components/ui'
import { api, APIError, type InvoiceRegistryRecord } from '@/lib/api'
import toast from 'react-hot-toast'
import type { Order } from '@/types'
import { useBranding } from '@/contexts/BrandingContext'
import { useBusiness } from '@/contexts/BusinessContext'
const PdfPreviewModal = dynamic(
  () => import('@/components/pdf/PdfPreviewModal').then(m => m.PdfPreviewModal),
  { ssr: false },
)
import { orderToPdfModel } from '@/lib/pdf/models'
import { shareSlugAlma } from '@/lib/pdf/format'
import type { InvoicePdfModel } from '@/lib/pdf/types'
import type { BusinessBranding } from '@/types/branding'
import { defaultBusinessBranding, readCachedBranding } from '@/lib/branding-defaults'
import { fetchLogoDataUrl } from '@/lib/pdf/branding'
import { withTimeout } from '@/lib/pdf/timeout'

type InvoiceRegistryResponse = {
  invoices: InvoiceRegistryRecord[]
  totals: { count: number; amount: number; paid: number; unpaid: number }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const INVOICE_READY_TIMEOUT_MS = 5000

export default function InvoicePage() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [preview, setPreview] = useState<Order | null>(null)
  const [pdfModel, setPdfModel] = useState<InvoicePdfModel | null>(null)
  const [previewExternalUrl, setPreviewExternalUrl] = useState('')
  const [genLoading, setGenLoading] = useState(false)
  const [registry, setRegistry] = useState<InvoiceRegistryResponse | null>(null)
  const [registryLoading, setRegistryLoading] = useState(true)
  const [isBrandReady, setIsBrandReady] = useState(false)
  const [isInvoiceReady, setIsInvoiceReady] = useState(false)
  const [isPdfReady, setIsPdfReady] = useState(false)
  const [prepLoading, setPrepLoading] = useState(false)
  const openGuardRef = useRef(0)
  const { business } = useBusiness()
  const { branding, loading: brandingLoading, refetch: refetchBranding } = useBranding()
  const { data, loading, refetch: refetchOrders } = useOrders({ status: 'Delivered' })

  const loadRegistry = useCallback(async () => {
    setRegistryLoading(true)
    try {
      const params = new URLSearchParams({ business_id: business.id })
      if (search.trim()) params.set('search', search.trim())
      if (statusFilter) params.set('payment_status', statusFilter)
      const res = await fetch(`/api/invoice?${params.toString()}`, { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || res.statusText)
      setRegistry(j as InvoiceRegistryResponse)
    } catch (e) {
      toast.error((e as Error).message || 'Could not load invoices')
      setRegistry(null)
    } finally {
      setRegistryLoading(false)
    }
  }, [business.id, search, statusFilter])

  useEffect(() => {
    const t = window.setTimeout(() => void loadRegistry(), 150)
    return () => window.clearTimeout(t)
  }, [loadRegistry])

  const deliveredOrders = data?.orders ?? []
  const registryByOrder = useMemo(() => new Map((registry?.invoices ?? []).map(inv => [inv.orderId, inv])), [registry])
  const pendingOrders = deliveredOrders.filter(o =>
    !registryByOrder.has(o.id) && !o.invoice_num && (
      !search || [o.id, o.customer, o.product].some(v => v.toLowerCase().includes(search.toLowerCase()))
    )
  )
  const invoiceOrders = deliveredOrders.filter(o =>
    !search || [o.id, o.customer, o.product].some(v => v.toLowerCase().includes(search.toLowerCase()))
  )

  const invoices = registry?.invoices ?? []

  const liveOrFallbackBranding = useCallback(async (): Promise<{ branding: BusinessBranding; logoDataUrl?: string; source: 'live' | 'cached' | 'default' }> => {
    if (branding) {
      const logoDataUrl = await withTimeout(fetchLogoDataUrl(branding.logo_url), 8000, 'logo preload').catch(() => undefined)
      return { branding, logoDataUrl, source: 'live' }
    }

    const cached = readCachedBranding(business.id)
    if (cached) {
      const logoDataUrl = await withTimeout(fetchLogoDataUrl(cached.logo_url), 8000, 'cached logo preload').catch(() => undefined)
      return { branding: cached, logoDataUrl, source: 'cached' }
    }

    return { branding: defaultBusinessBranding(business.id), source: 'default' }
  }, [branding, business.id])

  async function waitForBrandingOnce() {
    if (branding) return
    await Promise.race([refetchBranding(), delay(INVOICE_READY_TIMEOUT_MS)])
  }

  function replaceInvoiceInRegistry(invoice: InvoiceRegistryRecord) {
    setRegistry(current => {
      if (!current) return current
      const invoices = current.invoices.map(item => item.id === invoice.id ? invoice : item)
      return {
        ...current,
        invoices,
        totals: {
          count: invoices.length,
          amount: invoices.reduce((sum, inv) => sum + Number(inv.amount || 0), 0),
          paid: invoices.filter(inv => inv.paymentStatus === 'PAID').length,
          unpaid: invoices.filter(inv => inv.paymentStatus === 'UNPAID').length,
        },
      }
    })
  }

  async function openPreview(order: Order, externalUrl = '', invoice: InvoiceRegistryRecord | null = null) {
    const guard = ++openGuardRef.current
    setPrepLoading(true)
    setPreview(order)
    setPreviewExternalUrl(externalUrl)
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

      const model = orderToPdfModel(order, resolved.branding, resolved.logoDataUrl, invoice?.invoiceNumber || order.invoice_num || undefined, { paymentStatus: invoice?.paymentStatus })
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
      setPdfModel(orderToPdfModel(order, defaultBusinessBranding(business.id), undefined, invoice?.invoiceNumber || order.invoice_num || undefined, { paymentStatus: invoice?.paymentStatus }))
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

  async function handleSaveToDrive(allowRegenerate = false) {
    if (!preview) return
    setGenLoading(true)
    try {
      const r = await api.mutations.generateInvoice(preview.id, { allowRegenerate })
      if (r?.ok) {
        const msg = r.duplicate
          ? `Invoice already exists: ${r.invoice_number || ''}`
          : r.drive_sync === 'pending'
            ? `Invoice ${r.invoice_number || ''} ready — Google Drive upload finishing in background`
            : `Saved invoice: ${r.invoice_number || ''}`
        toast.success(msg)
        await Promise.all([refetchOrders(), loadRegistry()])
      }
    } catch (e) {
      toast.error(e instanceof APIError ? e.userMessage : (e as Error).message)
    } finally {
      setGenLoading(false)
    }
  }

  async function regenerateInvoice(order: Order) {
    if (!window.confirm(`Regenerate invoice for order ${order.id}? The existing registry record will be updated and the event will be audited.`)) return
    setGenLoading(true)
    try {
      const r = await api.mutations.generateInvoice(order.id, { allowRegenerate: true })
      if (!r?.ok) throw new Error('Regeneration failed')
      toast.success(`Regenerated ${r.invoice_number || order.id}`)
      await Promise.all([refetchOrders(), loadRegistry()])
    } catch (e) {
      toast.error(e instanceof APIError ? e.userMessage : (e as Error).message)
    } finally {
      setGenLoading(false)
    }
  }

  async function updatePaymentStatus(invoice: InvoiceRegistryRecord, paymentStatus: string) {
    const optimistic = { ...invoice, paymentStatus: paymentStatus as InvoiceRegistryRecord['paymentStatus'] }
    replaceInvoiceInRegistry(optimistic)
    try {
      const res = await fetch('/api/invoice', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invoice.id, payment_status: paymentStatus }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Could not update invoice')
      if (j.invoice) replaceInvoiceInRegistry(j.invoice as InvoiceRegistryRecord)
      toast.success('Invoice status updated')
      await loadRegistry()
    } catch (e) {
      replaceInvoiceInRegistry(invoice)
      toast.error((e as Error).message || 'Could not update invoice')
    }
  }

  function invoiceUrl(invoice: InvoiceRegistryRecord) {
    return invoice.driveUrl || invoice.fileUrl || invoice.shareUrl || ''
  }

  function internalInvoiceUrl(invoice: InvoiceRegistryRecord) {
    return `/invoice/share/${shareSlugAlma(invoice.orderId)}`
  }

  function openInvoice(invoice: InvoiceRegistryRecord) {
    window.open(internalInvoiceUrl(invoice), '_blank', 'noopener,noreferrer')
  }

  async function shareInvoice(invoice: InvoiceRegistryRecord) {
    const url = `${window.location.origin}${internalInvoiceUrl(invoice)}`
    await navigator.clipboard.writeText(url)
    toast.success('Invoice link copied')
  }

  return (
    <>
      <PageHeader title="Invoices" subtitle={`${invoices.length} issued · ${pendingOrders.length} pending`} />

      <div className="p-4 md:p-6 pb-24 md:pb-6 space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-cream">{deliveredOrders.length}</p>
            <p className="text-[10px] text-zinc-500 mt-1">Delivered orders</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-green-400">{registry?.totals.count ?? 0}</p>
            <p className="text-[10px] text-zinc-500 mt-1">Invoiced</p>
          </Card>
          <Card className="p-4 text-center">
            <p className="text-2xl font-bold text-amber-400">{pendingOrders.length}</p>
            <p className="text-[10px] text-zinc-500 mt-1">Pending</p>
          </Card>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="flex-1 min-w-48"><SearchInput value={search} onChange={setSearch} placeholder="Search invoices, orders, customers…" /></div>
          <Select value={statusFilter} onChange={setStatusFilter} options={[
            { label: 'All payment status', value: '' },
            { label: 'Unpaid', value: 'UNPAID' },
            { label: 'Partial', value: 'PARTIAL' },
            { label: 'Paid', value: 'PAID' },
            { label: 'Void', value: 'VOID' },
          ]} />
        </div>

        {pendingOrders.length > 0 && !statusFilter && (
          <div>
            <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-amber-400 mb-2">Pending Invoices</p>
            <div className="space-y-2">
              {pendingOrders.map(o => (
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

        <div>
          <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-green-400 mb-2">Invoice Registry</p>
          {registryLoading ? (
            <div className="space-y-2">{Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
          ) : invoices.length > 0 ? (
            <div className="space-y-2">
              {invoices.map(inv => {
                const order = invoiceOrders.find(o => o.id === inv.orderId)
                return (
                  <Card key={inv.id} className="p-4 border-green-400/10">
                    <div className="flex flex-col md:flex-row md:items-center gap-3">
                      <button type="button" onClick={() => order ? openPreview(order, invoiceUrl(inv), inv) : openInvoice(inv)} className="flex-1 min-w-0 text-left">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="font-mono text-[11px] text-green-400 font-bold">{inv.invoiceNumber}</span>
                          <span className="font-mono text-[10px] text-gold-lt">Order {inv.orderId}</span>
                          <span className="rounded-full border border-border px-2 py-0.5 text-[9px] font-bold text-zinc-400">{inv.paymentStatus}</span>
                        </div>
                        <p className="text-sm font-semibold text-cream">{inv.customerName}</p>
                        <p className="text-[11px] text-zinc-500">
                          ৳ {Number(inv.amount || 0).toLocaleString('en-BD')} · {inv.generatedByName || 'System'} · {String(inv.createdAt).slice(0, 16).replace('T', ' ')}
                        </p>
                        {!!inv.events?.length && (
                          <p className="mt-1 text-[10px] text-zinc-600">
                            Last: {inv.events[0].type.replace(/_/g, ' ')} · {String(inv.events[0].createdAt).slice(0, 10)}
                          </p>
                        )}
                      </button>
                      <div className="flex gap-2 flex-wrap md:justify-end">
                        <Select value={inv.paymentStatus} onChange={value => void updatePaymentStatus(inv, value)} options={[
                          { label: 'Unpaid', value: 'UNPAID' },
                          { label: 'Partial', value: 'PARTIAL' },
                          { label: 'Paid', value: 'PAID' },
                          { label: 'Void', value: 'VOID' },
                        ]} />
                        <Button size="xs" variant="secondary" onClick={() => openInvoice(inv)}>Open</Button>
                        <Button size="xs" variant="secondary" onClick={() => void shareInvoice(inv)}>Share</Button>
                        {order && <Button size="xs" variant="gold" onClick={() => openPreview(order, invoiceUrl(inv), inv)}>Preview</Button>}
                        {order && <Button size="xs" variant="danger" onClick={() => void regenerateInvoice(order)} disabled={genLoading}>Regenerate</Button>}
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
          ) : (
            <Empty icon="◈" title="No invoice records" desc="Generate an invoice to create a persistent registry record." />
          )}
        </div>

        {!loading && deliveredOrders.length === 0 && (
          <Empty icon="◈" title="No delivered orders" desc="Invoices are generated for delivered orders" />
        )}
      </div>

      <PdfPreviewModal
        open={!!preview}
        onClose={() => { openGuardRef.current += 1; setPreview(null); setPreviewExternalUrl(''); setPdfModel(null); setPrepLoading(false); setIsPdfReady(false) }}
        baseModel={pdfModel}
        shareSlug={preview ? shareSlugAlma(preview.id) : undefined}
        externalUrl={previewExternalUrl}
        onSaveToDrive={handleSaveToDrive}
        saveToDriveLoading={genLoading}
        externalLoading={prepLoading}
        readinessLabel={readinessText}
      />
    </>
  )
}
