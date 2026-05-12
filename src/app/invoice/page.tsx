'use client'
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useOrders, useGenerateInvoice } from '@/hooks/useERP'
import { PageHeader, Card, StatusBadge, Button, SearchInput, Skeleton, Empty, GoldDivider } from '@/components/ui'
import { fmt } from '@/lib/utils'
import { MobileNav } from '@/components/layout/Sidebar'
import toast from 'react-hot-toast'
import type { Order } from '@/types'

function InvoicePreview({ order, onClose, onGenerate, loading }: { order: Order; onClose: () => void; onGenerate: () => void; loading: boolean }) {
  return (
    <motion.div className="fixed inset-0 z-50 flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div className="relative w-full max-w-lg bg-surface border border-border rounded-2xl overflow-hidden"
        initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 20 }}>
        {/* Invoice preview header */}
        <div className="bg-black px-6 py-5 flex items-center justify-between">
          <div>
            <p className="text-[11px] text-gold font-bold tracking-[0.14em]">ALMA LIFESTYLE</p>
            <p className="text-[9px] text-gold-dim tracking-[0.16em] mt-0.5">PREMIUM FASHION</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-zinc-500 font-bold tracking-[0.12em] uppercase">Invoice</p>
            <p className="font-mono text-sm text-cream font-bold">{order.invoice_num || 'AL-INV-2026-XXXX'}</p>
          </div>
        </div>
        <div className="h-0.5 bg-gradient-to-r from-transparent via-gold to-transparent" />

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[9px] font-bold tracking-[0.14em] uppercase text-zinc-500 mb-2">Bill To</p>
              <p className="font-bold text-cream">{order.customer}</p>
              <p className="text-[11px] text-zinc-500 font-mono">{order.phone}</p>
              <p className="text-[11px] text-zinc-500">{order.address}</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] font-bold tracking-[0.14em] uppercase text-zinc-500 mb-2">Order Details</p>
              <p className="text-[11px] text-zinc-500">Order: <span className="font-mono text-gold">{order.id}</span></p>
              <p className="text-[11px] text-zinc-500">Date: {order.date}</p>
              <p className="text-[11px] text-zinc-500">Via: {order.payment}</p>
            </div>
          </div>

          <GoldDivider />

          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/50">
                <th className="pb-2 text-left text-[9px] font-bold tracking-[0.10em] uppercase text-zinc-500">Product</th>
                <th className="pb-2 text-right text-[9px] font-bold tracking-[0.10em] uppercase text-zinc-500">Qty</th>
                <th className="pb-2 text-right text-[9px] font-bold tracking-[0.10em] uppercase text-zinc-500">Unit</th>
                <th className="pb-2 text-right text-[9px] font-bold tracking-[0.10em] uppercase text-zinc-500">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/50">
                <td className="py-3">
                  <p className="font-semibold text-cream">{order.product}</p>
                  <p className="text-[10px] text-zinc-500">{order.category}{order.size ? ` · ${order.size}` : ''}</p>
                </td>
                <td className="py-3 text-right text-zinc-400">{order.qty}</td>
                <td className="py-3 text-right tabular-nums">{fmt(order.unit_price)}</td>
                <td className="py-3 text-right font-bold tabular-nums">{fmt(order.unit_price * order.qty)}</td>
              </tr>
            </tbody>
          </table>

          <div className="flex justify-end">
            <div className="w-48 space-y-1.5">
              {order.discount > 0 && (
                <div className="flex justify-between text-[11px]"><span className="text-zinc-500">Discount</span><span className="text-red-400">-{fmt(order.discount)}</span></div>
              )}
              {order.shipping_fee > 0 && (
                <div className="flex justify-between text-[11px]"><span className="text-zinc-500">Delivery</span><span>{fmt(order.shipping_fee)}</span></div>
              )}
              <div className="flex justify-between pt-2 border-t border-border">
                <span className="text-[11px] font-bold text-zinc-400">TOTAL</span>
                <span className="text-base font-bold text-gold">{fmt(order.sell_price + order.shipping_fee)}</span>
              </div>
            </div>
          </div>

          <div className="text-center pt-2">
            <p className="text-[9px] text-zinc-600">0130-77777-33 · almatraders.com@gmail.com · facebook.com/AlmaLifestyle</p>
            <p className="text-[9px] text-zinc-700 mt-1">Thank you for choosing Alma Lifestyle.</p>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-border flex gap-2">
          {order.invoice_num
            ? <div className="flex-1 flex items-center gap-2 text-sm text-green-400 font-bold"><span>✓</span> Invoice generated: {order.invoice_num}</div>
            : <Button variant="gold" className="flex-1 justify-center" onClick={onGenerate} disabled={loading}>
                {loading ? 'Generating PDF…' : 'Generate & Save PDF'}
              </Button>
          }
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </motion.div>
    </motion.div>
  )
}

export default function InvoicePage() {
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<Order | null>(null)
  const { data, loading, refetch } = useOrders({ status: 'Delivered' })
  const { mutate: generateInvoice, loading: genLoading } = useGenerateInvoice()

  const orders = (data?.orders ?? []).filter(o =>
    !search || [o.id, o.customer, o.product].some(v => v.toLowerCase().includes(search.toLowerCase()))
  )

  const invoiced    = orders.filter(o => o.invoice_num)
  const uninvoiced  = orders.filter(o => !o.invoice_num)

  async function handleGenerate() {
    if (!preview) return
    const r = await generateInvoice(preview.id)
    if (r?.ok) { toast.success(`Invoice ${r.invoice_number} saved to Drive`); refetch() }
    else toast.error('Generation failed — check Automation Log')
  }

  return (
    <>
      <PageHeader title="Invoices" subtitle={`${invoiced.length} issued · ${uninvoiced.length} pending`}
        actions={<Button variant="gold">Batch Generate</Button>} />

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
                <div
  key={o.id}
  className="p-4 flex items-center gap-3 border border-amber-400/15 hover:border-amber-400/30 transition-colors cursor-pointer rounded-xl bg-card"
  onClick={() => setPreview(o)}
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
    <p className="font-bold text-cream">{fmt(o.sell_price)}</p>
    <p className="text-[10px] text-zinc-500">{o.date}</p>
  </div>

  <Button variant="gold" size="xs">Generate</Button>
</div>
              ))}
            </div>
          </div>
        )}

        {invoiced.length > 0 && (
          <div>
            <p className="text-[10px] font-bold tracking-[0.12em] uppercase text-green-400 mb-2">Issued Invoices</p>
            <div className="space-y-2">
              {invoiced.map(o => (
                <Card key={o.id} className="p-4 flex items-center gap-3 border-green-400/10 cursor-pointer hover:border-green-400/25 transition-colors" onClick={() => setPreview(o)}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-[11px] text-gold font-bold">{o.id}</span>
                      <span className="font-mono text-[10px] text-green-400 font-bold">{o.invoice_num}</span>
                    </div>
                    <p className="text-sm font-semibold text-cream">{o.customer}</p>
                    <p className="text-[11px] text-zinc-500">{o.product}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-cream">{fmt(o.sell_price)}</p>
                    <span className="text-[10px] text-green-400 font-semibold">✓ Issued</span>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {!loading && orders.length === 0 && <Empty icon="◈" title="No delivered orders" desc="Invoices are generated for delivered orders" />}

      </div>

      <AnimatePresence>
        {preview && (
          <InvoicePreview order={preview} onClose={() => setPreview(null)} onGenerate={handleGenerate} loading={genLoading} />
        )}
      </AnimatePresence>

      <MobileNav />
    </>
  )
}
