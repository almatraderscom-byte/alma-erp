'use client'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { Suspense, useCallback, useDeferredValue, useLayoutEffect, useMemo, useState, type UIEvent } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useUpdateStatus } from '@/hooks/useERP'
import { useOrdersData } from '@/contexts/OrdersDataContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { DateRangeFilter } from '@/components/date-filter/DateRangeFilter'
import {
  applyOrderFilters,
  filterOrdersByDateRange,
  sortOrders,
  summarizeOrders,
  statusCountsForPills,
} from '@/lib/order-analytics'
import { useMdUp } from '@/hooks/useMdUp'
import { PageHeader, Card, StatusBadge, PaymentTag, Button, SearchInput, Select, Avatar, StatRow, Skeleton, Empty, Money, BdtText } from '@/components/ui'
import { fmt, COURIER_STEPS, STATUS_COLORS } from '@/lib/utils'
import {
  calculateOrderProfit,
  orderProfitInputsFromOrder,
  projectedReturnLossBdt,
} from '@/lib/order-return-profit'
import { api, APIError } from '@/lib/api'
import toast from 'react-hot-toast'
import { safeFetchJson } from '@/lib/safe-fetch'
import type { Order, OrderStatus } from '@/types'
import { useActor } from '@/contexts/ActorContext'
import { useBusiness } from '@/contexts/BusinessContext'
import { can } from '@/lib/roles'
import { canEditOrder, canRequestOrderDelete } from '@/lib/order-access'
import { shareSlugAlma } from '@/lib/pdf/format'

const STATUSES: OrderStatus[] = ['Pending','Confirmed','Packed','Shipped','Delivered','RETURNED','RETURNED_PAID','RETURNED_UNPAID','CANCELLED']
const STATUS_NEXT: Partial<Record<OrderStatus, OrderStatus>> = { Pending:'Confirmed', Confirmed:'Packed', Packed:'Shipped', Shipped:'Delivered' }
const ORDER_ROW_HEIGHT = 64
const ORDER_WINDOW_SIZE = 70
const ORDER_OVERSCAN = 12
const NewOrderDrawer = dynamic(
  () => import('@/components/orders/new-order/new-order-drawer').then(mod => mod.NewOrderDrawer),
  { ssr: false, loading: () => null },
)
const TERMINAL_STATUSES = new Set<OrderStatus>([
  'Delivered', 'RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID', 'CANCELLED', 'Returned', 'Cancelled',
])
const DESTRUCTIVE_STATUS_META: Record<'CANCELLED' | 'RETURNED_PAID' | 'RETURNED_UNPAID', { title: string; body: string; label: string }> = {
  CANCELLED: {
    title: 'Cancel order?',
    body: 'This excludes the order from revenue and prevents commission generation.',
    label: 'Cancel Order',
  },
  RETURNED_PAID: {
    title: 'Mark returned (paid delivery)?',
    body: 'Customer refused the product but paid delivery. Inventory will be marked for restock.',
    label: 'Confirm returned (paid)',
  },
  RETURNED_UNPAID: {
    title: 'Mark returned (refused)?',
    body: 'Customer refused everything. Inventory will be marked for restock.',
    label: 'Confirm returned (refused)',
  },
}

function orderStatusKey(status: string) {
  return status.trim().toUpperCase().replace(/\s+/g, '_')
}

// ═══════════════════════════════════════════════════════════════════════════
// ORDER DETAIL DRAWER (unchanged)
// ═══════════════════════════════════════════════════════════════════════════

function OrderDrawer({ order, onClose, onStatusChange }: { order: Order; onClose: () => void; onStatusChange: () => void }) {
  const { role, userId } = useActor()
  const { business } = useBusiness()
  const mayAdvance = can(role, 'ordersAdvanceStatus')
  const mayInvoice = can(role, 'ordersGenerateInvoice')
  const mayEdit = canEditOrder(role, userId, order)
  const mayRequestDelete = canRequestOrderDelete(role)
  const { mutate: updateStatus, loading: statusLoading } = useUpdateStatus()
  const [invLoading, setInvLoading] = useState(false)
  const [invoiceLookupLoading, setInvoiceLookupLoading] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [confirmStatus, setConfirmStatus] = useState<'CANCELLED' | 'RETURNED_PAID' | 'RETURNED_UNPAID' | null>(null)
  const [returnReason, setReturnReason] = useState('')
  const [showEdit, setShowEdit] = useState(false)
  const [showDeleteRequest, setShowDeleteRequest] = useState(false)
  const [editBusy, setEditBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteReason, setDeleteReason] = useState('')
  const [editForm, setEditForm] = useState({
    customer: order.customer,
    phone: order.phone,
    address: order.address,
    product: order.product,
    qty: String(order.qty ?? 1),
    unit_price: String(order.unit_price ?? 0),
    payment: order.payment,
    notes: order.notes || '',
  })

  useLayoutEffect(() => {
    setShareUrl('')
    setShowEdit(false)
    setShowDeleteRequest(false)
    setDeleteReason('')
    setReturnReason('')
    setConfirmStatus(null)
    setEditForm({
      customer: order.customer,
      phone: order.phone,
      address: order.address,
      product: order.product,
      qty: String(order.qty ?? 1),
      unit_price: String(order.unit_price ?? 0),
      payment: order.payment,
      notes: order.notes || '',
    })
  }, [order.id, order.customer, order.phone, order.address, order.product, order.qty, order.unit_price, order.payment, order.notes])

  async function submitOrderEdit(e: React.FormEvent) {
    e.preventDefault()
    if (editBusy) return
    setEditBusy(true)
    try {
      const result = await safeFetchJson<{ ok?: boolean; error?: { message?: string }; failed?: Array<{ field: string; error?: string }> }>(
        '/api/orders/orders/edit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            order_id: order.id,
            business_id: business.id,
            fields: {
              customer: editForm.customer,
              phone: editForm.phone,
              address: editForm.address,
              product: editForm.product,
              qty: Number(editForm.qty),
              unit_price: Number(editForm.unit_price),
              payment: editForm.payment,
              notes: editForm.notes,
            },
          }),
        },
      )
      if (!result.ok) throw new Error(result.error.message)
      if (result.data?.failed?.length) {
        toast.error(`Some fields failed: ${result.data.failed.map(f => f.field).join(', ')}`)
      } else {
        toast.success('Order updated')
      }
      setShowEdit(false)
      onStatusChange()
    } catch (err) {
      toast.error((err as Error).message || 'Could not update order')
    } finally {
      setEditBusy(false)
    }
  }

  async function submitDeleteRequest() {
    if (deleteBusy) return
    if (deleteReason.trim().length < 5) {
      toast.error('Enter a delete reason (at least 5 characters)')
      return
    }
    setDeleteBusy(true)
    try {
      const result = await safeFetchJson<{ ok?: boolean; duplicate?: boolean; message?: string; error?: { message?: string } }>(
        '/api/orders/orders/delete-request',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            order_id: order.id,
            business_id: business.id,
            reason: deleteReason.trim(),
          }),
        },
      )
      if (!result.ok) throw new Error(result.error.message)
      toast.success(result.data?.message || 'Delete request sent for Super Admin approval')
      setShowDeleteRequest(false)
      setDeleteReason('')
    } catch (err) {
      toast.error((err as Error).message || 'Could not submit delete request')
    } finally {
      setDeleteBusy(false)
    }
  }

  const profitInputs = useMemo(
    () => orderProfitInputsFromOrder(order),
    [order.qty, order.unit_price, order.discount, order.add_discount, order.sell_price, order.cogs, order.shipping_fee, order.courier_charge, order.inventoryCost],
  )

  const profitDisplay = useMemo(() => {
    const key = orderStatusKey(order.status)
    const calc = calculateOrderProfit(order.status, profitInputs)
    const roundTrip = 2 * profitInputs.courierCharge

    if (key === 'DELIVERED') {
      const amount = Number(order.net_profit ?? order.realizedProfit ?? calc.netProfit)
      const margin = order.sell_price > 0 ? Math.round(amount / order.sell_price * 100) : 0
      return {
        label: 'Profit',
        amount,
        detail: `Margin ${margin}% (incl. shipping)`,
        amountClass: 'text-green-400',
        marginLabel: 'Margin',
        marginValue: `${margin}%`,
      }
    }
    if (key === 'RETURNED_PAID') {
      const net = Number(order.return_net_profit ?? calc.netProfit)
      const loss = net < 0 ? Math.abs(net) : 0
      return {
        label: 'Return loss',
        amount: -loss,
        detail: `Customer paid ৳${profitInputs.shippingFee}, courier round-trip ৳${roundTrip}`,
        amountClass: 'text-amber-400',
        marginLabel: 'Net',
        marginValue: fmt(net),
      }
    }
    if (key === 'RETURNED_UNPAID' || key === 'RETURNED') {
      const net = Number(order.return_net_profit ?? calc.netProfit)
      return {
        label: 'Return loss',
        amount: net,
        detail: 'Refused: full courier loss',
        amountClass: 'text-red-400',
        marginLabel: 'Net',
        marginValue: fmt(net),
      }
    }
    if (key === 'CANCELLED' || key === 'CANCELED') {
      return {
        label: 'Profit',
        amount: 0,
        detail: 'No financial impact',
        amountClass: 'text-zinc-500',
        marginLabel: 'Margin',
        marginValue: '—',
      }
    }
    const est = Number(order.estimatedProfit ?? calc.netProfit)
    return {
      label: 'Est. profit',
      amount: est,
      detail: 'Estimated',
      amountClass: 'text-gold',
      marginLabel: 'Margin',
      marginValue: order.sell_price > 0 ? `${Math.round(est / order.sell_price * 100)}%` : '—',
    }
  }, [order, profitInputs])

  const returnLossPreview = useMemo(() => {
    if (!confirmStatus || confirmStatus === 'CANCELLED') return null
    const loss = projectedReturnLossBdt(confirmStatus, profitInputs)
    const roundTrip = 2 * profitInputs.courierCharge
    if (confirmStatus === 'RETURNED_UNPAID') {
      return `This will record a loss of ৳${roundTrip} (round-trip courier).`
    }
    if (loss === 0) {
      return 'Shipping collected covers courier round-trip — minimal or no loss.'
    }
    return `This will record a loss of ৳${loss} (customer paid ৳${profitInputs.shippingFee} shipping; courier round-trip ৳${roundTrip}).`
  }, [confirmStatus, profitInputs])

  const steps = COURIER_STEPS[order.status] ?? COURIER_STEPS.Pending!
  const nextStatus = STATUS_NEXT[order.status]
  const canCancel = mayAdvance && !TERMINAL_STATUSES.has(order.status)
  const isReturnTerminal = ['RETURNED', 'RETURNED_PAID', 'RETURNED_UNPAID', 'Returned'].includes(order.status)
  const canReturn = mayAdvance && !isReturnTerminal && !['CANCELLED', 'Cancelled'].includes(order.status) && ['Delivered', 'Shipped'].includes(order.status)
  const internalInvoiceUrl = `/invoice/share/${shareSlugAlma(order.id)}`

  async function handleStatusAdvance() {
    if (!nextStatus) return
    const r = await updateStatus(order.id, nextStatus)
    if (r?.ok) { toast.success(`${order.id} → ${nextStatus}`); onStatusChange() }
    else toast.error('Status update failed')
  }

  async function handleDestructiveStatus() {
    if (!confirmStatus) return
    const target = confirmStatus
    const reason = returnReason.trim()
    const r = await updateStatus(order.id, target, reason || undefined)
    if (r?.ok) {
      toast.success(`${order.id} → ${target.replace(/_/g, ' ')}`)
      setConfirmStatus(null)
      setReturnReason('')
      onStatusChange()
    } else {
      toast.error('Status update failed')
    }
  }

  async function handleInvoice() {
    setInvLoading(true)
    try {
      const r = await api.mutations.generateInvoice(order.id)
      if (r?.ok) {
        const url = internalInvoiceUrl
        setShareUrl(url)
        if (r.duplicate) {
          toast.success(
            `Invoice ${r.invoice_number} already on file — preview ready`,
          )
        } else {
          toast.success(
            `Invoice ${r.invoice_number} saved — preview ready`,
          )
        }
        onStatusChange()
      } else {
        toast.error('Invoice was not created (server returned ok: false)')
      }
    } catch (e) {
      const msg = e instanceof APIError ? e.userMessage : (e as Error).message
      console.error('[GenerateInvoice]', { orderId: order.id, err: e })
      toast.error(msg || 'Invoice generation failed')
    } finally {
      setInvLoading(false)
    }
  }

  async function copyInvoiceLink() {
    if (!shareUrl) return
    try {
      const url = shareUrl.startsWith('/') ? `${window.location.origin}${shareUrl}` : shareUrl
      await navigator.clipboard.writeText(url)
      toast.success('Invoice link copied')
    } catch (e) {
      console.error('[CopyInvoiceLink]', e)
      toast.error('Could not copy — copy the URL from the address bar after opening the PDF')
    }
  }

  async function openLinkedInvoice() {
    setInvoiceLookupLoading(true)
    try {
      const result = await safeFetchJson<Record<string, unknown>>(
        `/api/invoice?order_id=${encodeURIComponent(order.id)}&business_id=${encodeURIComponent(order.business_id || 'ALMA_LIFESTYLE')}`,
        { cache: 'no-store' },
      )
      if (!result.ok) throw new Error(result.error.message)
      setShareUrl(internalInvoiceUrl)
      window.open(internalInvoiceUrl, '_blank', 'noopener,noreferrer')
    } catch (e) {
      toast.error((e as Error).message || 'Could not open invoice')
    } finally {
      setInvoiceLookupLoading(false)
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex justify-end md:z-50"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        className="relative flex h-full max-h-[100dvh] w-full max-w-md flex-col overflow-y-auto border-l border-border bg-surface scrollbar-gold"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 26, stiffness: 300 }}
      >

        <div className="sticky top-0 bg-surface/95 backdrop-blur border-b border-border px-5 py-4 z-10">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] text-gold font-bold mb-1">{order.id}</p>
              <p className="text-sm font-bold text-cream leading-tight">{order.product}</p>
              <div className="mt-2"><StatusBadge status={order.status} /></div>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-xl border border-border flex items-center justify-center text-zinc-500 hover:text-cream hover:bg-white/[0.04] transition-colors shrink-0 mt-1">×</button>
          </div>
        </div>

        <div className="flex-1 space-y-5 p-5 max-md:pb-[calc(4.75rem+env(safe-area-inset-bottom,0px)+12px)] md:pb-5">

          <div className="grid grid-cols-3 gap-3">
            <div className="bg-card rounded-xl p-3 text-center">
              <p className="text-[10px] text-zinc-500 mb-1">Total</p>
              <Money amount={order.sell_price ?? 0} className="text-base font-bold text-gold" />
            </div>
            <div className="bg-card rounded-xl p-3 text-center">
              <p className="text-[10px] text-zinc-500 mb-1">{profitDisplay.label}</p>
              <Money amount={profitDisplay.amount} className={`text-base font-bold ${profitDisplay.amountClass}`} />
              <p className="text-[9px] text-zinc-500 mt-1 leading-tight">{profitDisplay.detail}</p>
            </div>
            <div className="bg-card rounded-xl p-3 text-center">
              <p className="text-[10px] text-zinc-500 mb-1">{profitDisplay.marginLabel}</p>
              <p className={`text-base font-bold ${profitDisplay.amountClass}`}>{profitDisplay.marginValue}</p>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-zinc-500 mb-3">Customer</p>
            <div className="bg-card rounded-xl p-4 flex items-center gap-3">
              <Avatar name={order.customer} size="md" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-cream">{order.customer}</p>
                <p className="text-[11px] text-zinc-500 font-mono">{order.phone}</p>
                <p className="text-[11px] text-zinc-500 truncate">{order.address}</p>
              </div>
              <a href={`https://wa.me/880${order.phone.slice(1)}`} target="_blank" rel="noreferrer"
                className="w-8 h-8 rounded-xl bg-green-400/10 border border-green-400/20 flex items-center justify-center text-green-400 hover:bg-green-400/20 transition-colors text-sm shrink-0">
                ⊞
              </a>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-zinc-500 mb-3">Order Details</p>
            <div className="bg-card rounded-xl p-4 space-y-0">
              <StatRow label="Date"     value={order.date} />
              <StatRow label="Product"  value={order.product} />
              <StatRow label="Category" value={order.category} />
              <StatRow label="Size"     value={order.size || '—'} />
              <StatRow label="Qty" value={<>{order.qty} × <Money amount={order.unit_price ?? 0} /></>} />
              <StatRow label="Payment"  value={order.payment} />
              <StatRow label="Source"   value={order.source} />
              {order.handled_by && <StatRow label="Handled by" value={order.handled_by} />}
              {order.notes && <StatRow label="Notes" value={order.notes} valueClass="text-amber-400" />}
            </div>
          </div>

          {order.sla_status && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-400/5 border border-amber-400/15">
              <span className="text-amber-400 text-sm">⚡</span>
              <span className="text-xs text-amber-300">{order.sla_status}</span>
            </div>
          )}

          <div>
            <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-zinc-500 mb-3">
              Courier — {order.courier || 'Not assigned'}
            </p>
            {order.tracking_id && (
              <div className="flex items-center justify-between bg-card rounded-xl px-4 py-3 mb-3">
                <div>
                  <p className="text-[10px] text-zinc-500 mb-1">Tracking ID</p>
                  <p className="font-mono text-xs text-gold-lt font-bold">{order.tracking_id}</p>
                </div>
                <button onClick={() => navigator.clipboard?.writeText(order.tracking_id).then(() => toast.success('Copied'))}
                  className="text-zinc-500 hover:text-zinc-300 text-sm transition-colors">⎘</button>
              </div>
            )}
            <div className="space-y-3">
              {steps.map((step, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className={`w-6 h-6 rounded-full border flex items-center justify-center text-[10px] shrink-0 mt-0.5 ${step.done ? 'bg-green-400/10 border-green-400/40 text-green-400' : step.active ? 'bg-blue-400/10 border-blue-400/40 text-blue-400' : 'bg-border border-border/80 text-zinc-600'}`}>
                    {step.done ? '✓' : step.active ? '●' : '○'}
                  </div>
                  <div className="flex-1">
                    <p className={`text-xs font-semibold ${step.done || step.active ? 'text-cream' : 'text-zinc-600'}`}>{step.label}</p>
                    {step.active && <p className="text-[10px] text-blue-400 mt-0.5">In progress</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {order.invoice_num && (
            <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-gold/5 border border-gold-dim/30">
              <div>
                <p className="text-[10px] text-zinc-500 mb-1">Invoice</p>
                <p className="font-mono text-xs text-gold-lt font-bold">{order.invoice_num}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-green-400 font-semibold">✓ Generated</span>
                <Button size="xs" variant="secondary" onClick={openLinkedInvoice} disabled={invoiceLookupLoading}>
                  {invoiceLookupLoading ? 'Opening…' : 'Open'}
                </Button>
              </div>
            </div>
          )}

        </div>

        <div className="sticky bottom-0 z-10 space-y-2 border-t border-border bg-surface/95 px-4 pt-4 pb-[max(1rem,calc(0.75rem+env(safe-area-inset-bottom,0px)))] backdrop-blur md:p-4">
          {(mayEdit || mayRequestDelete) && (
            <div className="grid grid-cols-2 gap-2">
              {mayEdit && (
                <Button variant="secondary" className="justify-center min-h-[42px]" onClick={() => setShowEdit(true)} disabled={statusLoading}>
                  Edit order
                </Button>
              )}
              {mayRequestDelete && (
                <Button variant="danger" className="justify-center min-h-[42px]" onClick={() => setShowDeleteRequest(true)} disabled={statusLoading}>
                  Request delete
                </Button>
              )}
            </div>
          )}
          {mayEdit && role === 'STAFF' && (
            <p className="text-[10px] text-zinc-500 text-center">
              You can edit your own orders while Pending, Confirmed, or Packed. Wrong totals need Super Admin delete approval.
            </p>
          )}
          {nextStatus && mayAdvance && (
            <Button variant="gold" className="w-full justify-center" onClick={handleStatusAdvance} disabled={statusLoading}>
              {statusLoading ? 'Updating…' : `Mark as ${nextStatus} →`}
            </Button>
          )}
          {mayAdvance && (canCancel || canReturn) && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {canCancel && (
                <Button variant="danger" className="justify-center min-h-[42px]" onClick={() => { setReturnReason(''); setConfirmStatus('CANCELLED') }} disabled={statusLoading}>
                  Cancel Order
                </Button>
              )}
              {canReturn && (
                <>
                  <Button variant="danger" className="justify-center min-h-[42px]" onClick={() => { setReturnReason(''); setConfirmStatus('RETURNED_PAID') }} disabled={statusLoading}>
                    Returned (paid delivery)
                  </Button>
                  <Button variant="danger" className="justify-center min-h-[42px]" onClick={() => { setReturnReason(''); setConfirmStatus('RETURNED_UNPAID') }} disabled={statusLoading}>
                    Returned (refused)
                  </Button>
                </>
              )}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1 justify-center" onClick={handleInvoice} disabled={!mayInvoice || invLoading || !!order.invoice_num}>
                {invLoading ? 'Generating…' : order.invoice_num ? 'Invoiced ✓' : !mayInvoice ? 'Invoice (admin)' : 'Generate Invoice'}
              </Button>
              <Button variant="ghost" className="flex-1 justify-center"
                onClick={() => window.open(`https://wa.me/880${order.phone.slice(1)}?text=Hi%20${encodeURIComponent(order.customer)}%2C%20your%20order%20${order.id}%20update%3A%20`, '_blank')}>
                WhatsApp
              </Button>
            </div>
            {shareUrl && (
              <div className="flex flex-col gap-2 rounded-xl border border-gold-dim/25 bg-gold/[0.04] p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Invoice link</p>
                <Button variant="gold" className="w-full justify-center text-xs" type="button" onClick={copyInvoiceLink}>
                  Copy invoice link
                </Button>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="ghost" className="justify-center text-xs min-h-[44px]" type="button"
                    onClick={() => window.open(shareUrl || internalInvoiceUrl, '_blank', 'noopener,noreferrer')}>
                    Open PDF
                  </Button>
                  <Button variant="ghost" className="justify-center text-xs min-h-[44px]" type="button"
                    onClick={() => {
                      const url = shareUrl.startsWith('/') ? `${window.location.origin}${shareUrl}` : shareUrl
                      window.open(`https://wa.me/?text=${encodeURIComponent(`Invoice PDF (${order.id}): ${url}`)}`, '_blank', 'noopener,noreferrer')
                    }}>
                    Share PDF
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
        {showEdit && (
          <div className="absolute inset-0 z-20 flex items-end sm:items-center justify-center bg-black/70 p-4">
            <form
              onSubmit={e => void submitOrderEdit(e)}
              className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-3xl border border-border bg-card p-5 shadow-2xl space-y-3"
            >
              <p className="text-sm font-bold text-cream">Edit order {order.id}</p>
              <p className="text-[11px] text-zinc-500">Updates sync to the orders sheet. Sell price and profit recalculate automatically.</p>
              {(['customer', 'phone', 'address', 'product', 'qty', 'unit_price', 'payment', 'notes'] as const).map(key => (
                <label key={key} className="block text-[11px]">
                  <span className="font-bold uppercase tracking-wider text-zinc-500">{key.replace('_', ' ')}</span>
                  {key === 'notes' ? (
                    <textarea
                      value={editForm[key]}
                      onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))}
                      className="mt-1 min-h-16 w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-sm text-cream"
                    />
                  ) : (
                    <input
                      value={editForm[key]}
                      onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))}
                      className="mt-1 w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-sm text-cream"
                    />
                  )}
                </label>
              ))}
              <div className="flex justify-end gap-2 pt-2">
                <Button size="xs" variant="secondary" type="button" onClick={() => setShowEdit(false)} disabled={editBusy}>Cancel</Button>
                <Button size="xs" variant="gold" type="submit" disabled={editBusy}>{editBusy ? 'Saving…' : 'Save changes'}</Button>
              </div>
            </form>
          </div>
        )}
        {showDeleteRequest && (
          <div className="absolute inset-0 z-20 flex items-end sm:items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-sm rounded-3xl border border-red-400/25 bg-card p-5 shadow-2xl">
              <p className="text-sm font-bold text-cream">Request order delete</p>
              <p className="mt-2 text-xs text-zinc-400">
                Super Admin must approve in Approvals. The order is hidden from lists after approval (sheet row kept for audit).
              </p>
              <textarea
                value={deleteReason}
                onChange={e => setDeleteReason(e.target.value)}
                placeholder="Why should this order be removed? (min 5 characters)"
                className="mt-3 min-h-24 w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-sm text-cream"
              />
              <div className="mt-4 flex justify-end gap-2">
                <Button size="xs" variant="secondary" onClick={() => setShowDeleteRequest(false)} disabled={deleteBusy}>Cancel</Button>
                <Button size="xs" variant="danger" onClick={() => void submitDeleteRequest()} disabled={deleteBusy}>
                  {deleteBusy ? 'Submitting…' : 'Submit for approval'}
                </Button>
              </div>
            </div>
          </div>
        )}
        {confirmStatus && (
          <div className="absolute inset-0 z-20 flex items-end sm:items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-sm rounded-3xl border border-red-400/25 bg-card p-5 shadow-2xl">
              <p className="text-sm font-bold text-cream">
                {confirmStatus === 'CANCELLED' ? DESTRUCTIVE_STATUS_META.CANCELLED.title : DESTRUCTIVE_STATUS_META[confirmStatus].title}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                {confirmStatus === 'CANCELLED' ? DESTRUCTIVE_STATUS_META.CANCELLED.body : DESTRUCTIVE_STATUS_META[confirmStatus].body}
              </p>
              {returnLossPreview && (
                <p className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">
                  {returnLossPreview}
                </p>
              )}
              <div className="mt-4 rounded-xl border border-border bg-black/25 p-3 text-[11px]">
                <p className="text-zinc-500">Order</p>
                <p className="font-mono text-gold-lt">{order.id}</p>
                <p className="mt-2 text-zinc-500">Current status</p>
                <p className="text-cream">{order.status}</p>
              </div>
              {confirmStatus !== 'CANCELLED' && (
                <label className="mt-4 block text-[11px]">
                  <span className="font-bold uppercase tracking-wider text-zinc-500">Return reason (optional)</span>
                  <textarea
                    value={returnReason}
                    onChange={e => setReturnReason(e.target.value)}
                    placeholder="Why did the customer return or refuse?"
                    className="mt-1 min-h-20 w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-sm text-cream"
                  />
                </label>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <Button size="xs" variant="secondary" onClick={() => { setConfirmStatus(null); setReturnReason('') }} disabled={statusLoading}>Keep order</Button>
                <Button size="xs" variant="danger" onClick={() => void handleDestructiveStatus()} disabled={statusLoading}>
                  {statusLoading ? 'Updating…' : (confirmStatus === 'CANCELLED' ? DESTRUCTIVE_STATUS_META.CANCELLED.label : DESTRUCTIVE_STATUS_META[confirmStatus].label)}
                </Button>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// ORDERS PAGE
// ═══════════════════════════════════════════════════════════════════════════

export default function OrdersPage() {
  return (
    <Suspense fallback={null}>
      <OrdersPageContent />
    </Suspense>
  )
}

function OrdersPageContent() {
  const mdUp = useMdUp()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [status,   setStatus]   = useState('')
  const [source,   setSource]   = useState('')
  const [payment,  setPayment]  = useState('')
  const [sort,     setSort]     = useState('newest')
  const [selected, setSelected] = useState<Order | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [rowWindow, setRowWindow] = useState({ start: 0, end: ORDER_WINDOW_SIZE })

  useLayoutEffect(() => {
    if (searchParams.get('new') === '1' && mdUp) {
      setShowNew(true)
      router.replace('/orders', { scroll: false })
    }
  }, [searchParams, router, mdUp])

  const { orders: allOrders, loading, refetch, enabled } = useOrdersData()
  const { businessId } = useBusiness()
  const { range, label: rangeLabel } = useDateRange()

  const dateFiltered = useMemo(
    () => filterOrdersByDateRange(allOrders, range),
    [allOrders, range],
  )

  const filtered = useMemo(
    () => applyOrderFilters(dateFiltered, { status, source, payment, search: deferredSearch }),
    [dateFiltered, status, source, payment, deferredSearch],
  )

  const orders = useMemo(() => sortOrders(filtered, sort), [filtered, sort])
  useLayoutEffect(() => {
    setRowWindow({ start: 0, end: ORDER_WINDOW_SIZE })
  }, [deferredSearch, status, source, payment, sort, range.start, range.end])
  const visibleOrders = useMemo(
    () => orders.slice(rowWindow.start, Math.min(rowWindow.end, orders.length)),
    [orders, rowWindow],
  )
  const mobileOrders = useMemo(() => orders.slice(0, 80), [orders])
  const topSpacer = rowWindow.start * ORDER_ROW_HEIGHT
  const bottomSpacer = Math.max(0, (orders.length - Math.min(rowWindow.end, orders.length)) * ORDER_ROW_HEIGHT)
  const onOrdersScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const start = Math.max(0, Math.floor(e.currentTarget.scrollTop / ORDER_ROW_HEIGHT) - ORDER_OVERSCAN)
    const end = start + ORDER_WINDOW_SIZE + ORDER_OVERSCAN * 2
    setRowWindow(prev => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [])

  const summary = useMemo(() => summarizeOrders(filtered), [filtered])
  const statusCounts = useMemo(
    () => statusCountsForPills(dateFiltered, STATUSES),
    [dateFiltered],
  )

  if (!enabled || businessId !== 'ALMA_LIFESTYLE') {
    return (
      <>
        <PageHeader title="Orders" subtitle="Alma Lifestyle" />
        <div className="p-4 md:p-8">
          <Empty
            icon="◫"
            title="Orders are for Alma Lifestyle"
            desc="Switch to Alma Lifestyle or open Trading from the business menu."
          />
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle={<>{summary.total} orders · <BdtText value={fmt(summary.total_revenue)} /> revenue · {rangeLabel}</>}
        actions={
          <>
            <Link
              href="/orders/new"
              className="md:hidden inline-flex items-center gap-2 rounded-xl border border-gold-dim/50 bg-gold/10 px-3.5 py-2 text-xs font-semibold text-gold-lt transition-all duration-150 hover:bg-gold/20 active:scale-[0.97]"
            >
              + New Order
            </Link>
            <Button variant="gold" className="hidden md:inline-flex" onClick={() => setShowNew(true)}>
              + New Order
            </Button>
          </>
        }
      />

      <motion.div layout className="min-w-0 max-w-full space-y-4 px-3 py-4 pb-24 sm:px-6 md:pb-6">

        <DateRangeFilter />

        {/* Status pills */}
        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          <button onClick={() => setStatus('')}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${!status ? 'bg-gold/10 border-gold-dim/50 text-gold-lt' : 'border-border text-zinc-500 hover:text-zinc-300'}`}>
            All <span className="ml-1 opacity-70">{dateFiltered.length}</span>
          </button>
          {STATUSES.map(s => {
            const c = STATUS_COLORS[s]
            const active = status === s
            return (
              <button key={s} onClick={() => setStatus(status === s ? '' : s)}
                className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${active ? `${c.text} ${c.bg} ${c.border}` : 'border-border text-zinc-500 hover:text-zinc-300'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                {s} <span className="opacity-70">{statusCounts[s] ?? 0}</span>
              </button>
            )
          })}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <div className="flex-1 min-w-48"><SearchInput value={search} onChange={setSearch} placeholder="Search orders, customers…" /></div>
          <Select value={source} onChange={setSource} options={[{ label:'All channels', value:'' }, { label:'Facebook', value:'Facebook' }, { label:'WhatsApp', value:'WhatsApp' }, { label:'Instagram', value:'Instagram' }]} />
          <Select value={payment} onChange={setPayment} options={[{ label:'All payments', value:'' }, { label:'COD', value:'COD' }, { label:'bKash', value:'bKash' }, { label:'Nagad', value:'Nagad' }]} />
          <Select value={sort} onChange={setSort} options={[{ label:'Newest', value:'newest' }, { label:'Oldest', value:'oldest' }, { label:'High price', value:'price' }, { label:'High profit', value:'profit' }]} />
        </div>

        {/* Summary bar */}
        <div className="flex items-center gap-4 px-4 py-3 bg-card border border-border rounded-xl text-xs transition-all duration-200">
          <span className="text-zinc-500">{summary.total} orders</span>
          <span className="w-px h-3 bg-border" />
          <Money amount={summary.total_revenue} className="text-gold font-bold" />
          <span className="w-px h-3 bg-border" />
          <span className="text-green-400 font-bold inline-flex items-center gap-1">
            <Money amount={summary.total_profit} /> profit
          </span>
        </div>

        {/* Orders table — desktop */}
        <Card className="hidden min-w-0 md:block">
          <div className="overflow-x-auto min-w-0 max-w-full table-scroll max-h-[72vh]" onScroll={onOrdersScroll}>
            <table className="w-full min-w-[1080px] text-xs border-collapse">
              <thead>
                <tr className="border-b border-border">
                  {['Order ID','Date','Customer','Product','Qty','Amount','Payment','Status','Courier','Profit'].map(h => (
                    <th key={h} className="px-3 py-3 text-left text-[10px] font-bold tracking-[0.08em] uppercase text-zinc-500 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array(6).fill(0).map((_, i) => (
                      <tr key={i} className="border-b border-border/50">
                        {Array(10).fill(0).map((__, j) => (
                          <td key={j} className="px-3 py-3.5"><Skeleton className="h-3 w-full" /></td>
                        ))}
                      </tr>
                    ))
                  : (
                    <>
                    {topSpacer > 0 && (
                      <tr aria-hidden="true">
                        <td colSpan={10} style={{ height: topSpacer }} className="p-0" />
                      </tr>
                    )}
                    {visibleOrders.map(o => (
                      <tr key={o.id} onClick={() => setSelected(o.id === selected?.id ? null : o)}
                        className={`border-b border-border/50 cursor-pointer transition-colors ${o.id === selected?.id ? 'bg-gold/5' : 'hover:bg-white/[0.015]'}`}>
                        <td className="px-3 py-3.5 font-mono text-[11px] text-gold font-bold whitespace-nowrap">{o.id}</td>
                        <td className="px-3 py-3.5 text-zinc-500 whitespace-nowrap">{o.date}</td>
                        <td className="px-3 py-3.5">
                          <p className="font-semibold text-cream">{o.customer}</p>
                          <p className="text-[10px] text-zinc-600 font-mono">{o.phone}</p>
                        </td>
                        <td className="px-3 py-3.5 max-w-[140px]">
                          <p className="text-cream truncate">{o.product}</p>
                          <p className="text-[10px] text-zinc-500">{o.category}</p>
                        </td>
                        <td className="px-3 py-3.5 text-center text-zinc-400">{o.qty}</td>
                        <td className="px-3 py-3.5 whitespace-nowrap"><Money amount={o.sell_price ?? 0} className="font-bold text-cream" /></td>
                        <td className="px-3 py-3.5"><PaymentTag method={o.payment} /></td>
                        <td className="px-3 py-3.5"><StatusBadge status={o.status} /></td>
                        <td className="px-3 py-3.5">
                          <p className="text-zinc-400">{o.courier || '—'}</p>
                          {o.tracking_id && <p className="font-mono text-[9px] text-zinc-600">{o.tracking_id}</p>}
                        </td>
                        <td className="px-3 py-3.5 whitespace-nowrap"><Money amount={o.profit ?? 0} className="font-bold text-green-400" /></td>
                      </tr>
                    ))}
                    {bottomSpacer > 0 && (
                      <tr aria-hidden="true">
                        <td colSpan={10} style={{ height: bottomSpacer }} className="p-0" />
                      </tr>
                    )}
                    </>
                  )
                }
              </tbody>
            </table>
            {!loading && orders.length === 0 && (
              <Empty icon="◫" title="No orders found for selected period" desc="Try a different date range or filters" />
            )}
          </div>
        </Card>

        {/* Orders cards — mobile */}
        <div className="md:hidden space-y-2">
          {loading
            ? Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            : mobileOrders.map(o => (
                <button key={o.id} onClick={() => setSelected(o.id === selected?.id ? null : o)} className="w-full text-left">
                  <Card className={`p-4 transition-colors ${o.id === selected?.id ? 'border-gold-dim/50' : ''}`}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <span className="font-mono text-[11px] text-gold font-bold">{o.id}</span>
                        <p className="text-sm font-semibold text-cream mt-0.5">{o.customer}</p>
                        <p className="text-[11px] text-zinc-500 truncate">{o.product}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <StatusBadge status={o.status} />
                        <Money amount={o.sell_price ?? 0} className="text-sm font-bold text-cream mt-1" />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <PaymentTag method={o.payment} />
                      <span className="text-[10px] text-zinc-600">{o.courier || '—'}</span>
                      <Money amount={o.profit ?? 0} className="ml-auto text-[11px] font-bold text-green-400" />
                    </div>
                  </Card>
                </button>
              ))
          }
          {!loading && orders.length === 0 && (
            <Empty icon="◫" title="No orders found for selected period" desc="Try a different date range or filters" />
          )}
          {!loading && orders.length > mobileOrders.length && (
            <p className="px-2 py-3 text-center text-[11px] text-zinc-500">
              Showing latest {mobileOrders.length.toLocaleString()} matches. Use filters/search for older orders.
            </p>
          )}
        </div>

      </motion.div>

      {/* Mobile FAB — always visible above MobileNav, only on mobile */}
      {!showNew && !selected && (
        <Link
          href="/orders/new"
          className="md:hidden fixed bottom-[72px] right-4 z-40 flex items-center gap-2 px-4 py-3 rounded-2xl bg-gold/90 text-black text-sm font-bold shadow-lg shadow-gold/20 active:scale-95 transition-transform"
          style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}
        >
          <span className="text-base leading-none">+</span>
          <span>New Order</span>
        </Link>
      )}

      {/* Drawers */}
      {showNew && mdUp && (
        <NewOrderDrawer
          onClose={() => setShowNew(false)}
          onCreated={() => {
            refetch()
            setShowNew(false)
          }}
        />
      )}
      <AnimatePresence>
        {selected && !showNew && (
          <OrderDrawer
            order={selected}
            onClose={() => setSelected(null)}
            onStatusChange={() => { refetch(); setSelected(null) }}
          />
        )}
      </AnimatePresence>
    </>
  )
}