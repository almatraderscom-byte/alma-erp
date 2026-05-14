'use client'
import Link from 'next/link'
import { Suspense, useLayoutEffect, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { useOrders, useUpdateStatus } from '@/hooks/useERP'
import { useMdUp } from '@/hooks/useMdUp'
import { NewOrderDrawer } from '@/components/orders/new-order/new-order-drawer'
import { PageHeader, Card, StatusBadge, PaymentTag, Button, SearchInput, Select, Avatar, StatRow, Skeleton, Empty } from '@/components/ui'
import { fmt, COURIER_STEPS, STATUS_COLORS } from '@/lib/utils'
import { api, APIError } from '@/lib/api'
import toast from 'react-hot-toast'
import type { Order, OrderStatus } from '@/types'

const STATUSES: OrderStatus[] = ['Pending','Confirmed','Packed','Shipped','Delivered','Returned','Cancelled']
const STATUS_NEXT: Partial<Record<OrderStatus, OrderStatus>> = { Pending:'Confirmed', Confirmed:'Packed', Packed:'Shipped', Shipped:'Delivered' }

// ═══════════════════════════════════════════════════════════════════════════
// ORDER DETAIL DRAWER (unchanged)
// ═══════════════════════════════════════════════════════════════════════════

function OrderDrawer({ order, onClose, onStatusChange }: { order: Order; onClose: () => void; onStatusChange: () => void }) {
  const { mutate: updateStatus, loading: statusLoading } = useUpdateStatus()
  const [invLoading, setInvLoading] = useState(false)

  const steps = COURIER_STEPS[order.status] ?? COURIER_STEPS.Pending!
  const nextStatus = STATUS_NEXT[order.status]

  async function handleStatusAdvance() {
    if (!nextStatus) return
    const r = await updateStatus(order.id, nextStatus)
    if (r?.ok) { toast.success(`${order.id} → ${nextStatus}`); onStatusChange() }
    else toast.error('Status update failed')
  }

  async function handleInvoice() {
    setInvLoading(true)
    try {
      const r = await api.mutations.generateInvoice(order.id)
      if (r?.ok) {
        const url = (r.drive_url || r.file_url || '').trim()
        toast.success(
          url
            ? `Invoice ${r.invoice_number} saved to Google Drive`
            : `Invoice ${r.invoice_number} recorded (no Drive URL returned)`,
        )
        if (url) window.open(url, '_blank', 'noopener,noreferrer')
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

  return (
    <motion.div className="fixed inset-0 z-50 flex justify-end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <motion.div className="relative w-full max-w-md bg-surface border-l border-border h-full overflow-y-auto scrollbar-gold flex flex-col"
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 26, stiffness: 300 }}>

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

        <div className="flex-1 p-5 space-y-5">

          <div className="grid grid-cols-3 gap-3">
            <div className="bg-card rounded-xl p-3 text-center">
              <p className="text-[10px] text-zinc-500 mb-1">Total</p>
              <p className="text-base font-bold text-gold">{fmt(order.sell_price)}</p>
            </div>
            <div className="bg-card rounded-xl p-3 text-center">
              <p className="text-[10px] text-zinc-500 mb-1">Profit</p>
              <p className="text-base font-bold text-green-400">{fmt(order.profit)}</p>
            </div>
            <div className="bg-card rounded-xl p-3 text-center">
              <p className="text-[10px] text-zinc-500 mb-1">Margin</p>
              <p className="text-base font-bold text-cream">{order.margin_pct}%</p>
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
              <StatRow label="Qty"      value={`${order.qty} × ${fmt(order.unit_price)}`} />
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
            <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-gold/5 border border-gold-dim/30">
              <div>
                <p className="text-[10px] text-zinc-500 mb-1">Invoice</p>
                <p className="font-mono text-xs text-gold-lt font-bold">{order.invoice_num}</p>
              </div>
              <span className="text-xs text-green-400 font-semibold">✓ Generated</span>
            </div>
          )}

        </div>

        <div className="sticky bottom-0 bg-surface/95 backdrop-blur border-t border-border p-4 space-y-2">
          {nextStatus && (
            <Button variant="gold" className="w-full justify-center" onClick={handleStatusAdvance} disabled={statusLoading}>
              {statusLoading ? 'Updating…' : `Mark as ${nextStatus} →`}
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1 justify-center" onClick={handleInvoice} disabled={invLoading || !!order.invoice_num}>
              {invLoading ? 'Generating…' : order.invoice_num ? 'Invoiced ✓' : 'Generate Invoice'}
            </Button>
            <Button variant="ghost" className="flex-1 justify-center"
              onClick={() => window.open(`https://wa.me/880${order.phone.slice(1)}?text=Hi%20${encodeURIComponent(order.customer)}%2C%20your%20order%20${order.id}%20update%3A%20`, '_blank')}>
              WhatsApp
            </Button>
          </div>
        </div>
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
  const [status,   setStatus]   = useState('')
  const [source,   setSource]   = useState('')
  const [payment,  setPayment]  = useState('')
  const [sort,     setSort]     = useState('newest')
  const [selected, setSelected] = useState<Order | null>(null)
  const [showNew, setShowNew] = useState(false)

  useLayoutEffect(() => {
    if (searchParams.get('new') === '1' && mdUp) {
      setShowNew(true)
      router.replace('/orders', { scroll: false })
    }
  }, [searchParams, router, mdUp])

  const { data, loading, refetch } = useOrders({
    status:  status  || undefined,
    source:  source  || undefined,
    payment: payment || undefined,
    search:  search  || undefined,
  })

  const orders = useMemo(() => {
    const o = data?.orders ?? []
    if (sort === 'profit') return [...o].sort((a, b) => b.profit - a.profit)
    if (sort === 'price')  return [...o].sort((a, b) => b.sell_price - a.sell_price)
    if (sort === 'oldest') return [...o].sort((a, b) => a.date.localeCompare(b.date))
    return [...o].sort((a, b) => b.date.localeCompare(a.date))
  }, [data, sort])

  const summary = data?.summary
  const statusCounts: Record<string, number> = {}
  STATUSES.forEach(s => { statusCounts[s] = (data?.orders ?? []).filter(o => o.status === s).length })

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle={`${summary?.total ?? 0} orders · ${fmt(summary?.total_revenue ?? 0)} revenue`}
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

      <div className="p-4 md:p-6 pb-24 md:pb-6 space-y-4">

        {/* Status pills */}
        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          <button onClick={() => setStatus('')}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${!status ? 'bg-gold/10 border-gold-dim/50 text-gold-lt' : 'border-border text-zinc-500 hover:text-zinc-300'}`}>
            All <span className="ml-1 opacity-70">{data?.orders?.length ?? 0}</span>
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
        {summary && (
          <div className="flex items-center gap-4 px-4 py-3 bg-card border border-border rounded-xl text-xs">
            <span className="text-zinc-500">{summary.total} orders</span>
            <span className="w-px h-3 bg-border" />
            <span className="text-gold font-bold">{fmt(summary.total_revenue)}</span>
            <span className="w-px h-3 bg-border" />
            <span className="text-green-400 font-bold">{fmt(summary.total_profit)} profit</span>
          </div>
        )}

        {/* Orders table — desktop */}
        <Card className="hidden md:block overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
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
                  : orders.map(o => (
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
                        <td className="px-3 py-3.5 font-bold text-cream tabular-nums whitespace-nowrap">{fmt(o.sell_price)}</td>
                        <td className="px-3 py-3.5"><PaymentTag method={o.payment} /></td>
                        <td className="px-3 py-3.5"><StatusBadge status={o.status} /></td>
                        <td className="px-3 py-3.5">
                          <p className="text-zinc-400">{o.courier || '—'}</p>
                          {o.tracking_id && <p className="font-mono text-[9px] text-zinc-600">{o.tracking_id}</p>}
                        </td>
                        <td className="px-3 py-3.5 font-bold text-green-400 tabular-nums whitespace-nowrap">{fmt(o.profit)}</td>
                      </tr>
                    ))
                }
              </tbody>
            </table>
            {!loading && orders.length === 0 && <Empty icon="◫" title="No orders match" desc="Try adjusting your filters" />}
          </div>
        </Card>

        {/* Orders cards — mobile */}
        <div className="md:hidden space-y-2">
          {loading
            ? Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            : orders.map(o => (
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
                        <p className="text-sm font-bold text-cream mt-1">{fmt(o.sell_price)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <PaymentTag method={o.payment} />
                      <span className="text-[10px] text-zinc-600">{o.courier || '—'}</span>
                      <span className="ml-auto text-[11px] font-bold text-green-400">{fmt(o.profit)}</span>
                    </div>
                  </Card>
                </button>
              ))
          }
          {!loading && orders.length === 0 && <Empty icon="◫" title="No orders match" desc="Try adjusting filters" />}
        </div>

      </div>

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
      <AnimatePresence>
        {showNew && mdUp && (
          <NewOrderDrawer
            onClose={() => setShowNew(false)}
            onCreated={() => {
              refetch()
              setShowNew(false)
            }}
          />
        )}
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