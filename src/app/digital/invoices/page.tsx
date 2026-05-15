'use client'
import { useState, useMemo } from 'react'
import { CditPageShell } from '@/components/digital/CditPageShell'
import { PaymentStatusBadge } from '@/components/digital/PaymentProgress'
import { useCditInvoices, useCreateCditInvoice, useCreateCditPayment } from '@/hooks/useDigital'
import { useBranding } from '@/contexts/BrandingContext'
import { useActor } from '@/contexts/ActorContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { DateRangeFilter } from '@/components/date-filter/DateRangeFilter'
import { can } from '@/lib/roles'
import { PdfPreviewModal } from '@/components/pdf/PdfPreviewModal'
import { cditInvoiceToPdfModel } from '@/lib/pdf/models'
import { shareSlugCdit } from '@/lib/pdf/format'
import { api } from '@/lib/api'
import { Card, Button, Skeleton, Empty, Select, Money } from '@/components/ui'
import { CDIT_PAYMENT_METHODS } from '@/types/cdit'
import type { CditInvoice, CditPayment } from '@/types/cdit'
import toast from 'react-hot-toast'

function invoiceYmd(inv: CditInvoice): string {
  const raw = inv.issued_date || inv.created_at || ''
  return String(raw).slice(0, 10)
}

function inRangeYmd(ymd: string, start: string, end: string): boolean {
  if (!ymd || ymd.length < 10) return true
  const e = end.slice(0, 10)
  return ymd >= start && ymd <= e
}

export default function DigitalInvoicesPage() {
  const { role } = useActor()
  const mayAdmin = can(role, 'cditAdminWrite')
  const { range, label: rangeLabel } = useDateRange()
  const [status, setStatus] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [payId, setPayId] = useState<string | null>(null)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState<string>(CDIT_PAYMENT_METHODS[0])
  const [previewInv, setPreviewInv] = useState<CditInvoice | null>(null)
  const [previewPayments, setPreviewPayments] = useState<CditPayment[]>([])
  const { branding } = useBranding()
  const [form, setForm] = useState({
    client_name: '', client_id: '', project_id: '', amount: '', invoice_type: 'one-time',
    due_date: '', recurring_interval: '', notes: '',
  })
  const { data, loading, refetch } = useCditInvoices(status || undefined)
  const { mutate: create, loading: saving } = useCreateCditInvoice()
  const { mutate: recordPay, loading: paying } = useCreateCditPayment()

  const pdfModel = useMemo(() => {
    if (!previewInv || !branding) return null
    return cditInvoiceToPdfModel(previewInv, previewPayments, branding)
  }, [previewInv, previewPayments, branding])

  async function openPreview(inv: CditInvoice) {
    setPreviewInv(inv)
    try {
      const r = await api.digital.payments.list({ invoice_id: inv.id })
      setPreviewPayments(r.payments || [])
    } catch {
      setPreviewPayments([])
    }
  }

  async function handleCreate() {
    if (!form.client_name || !form.amount) { toast.error('Client and amount required'); return }
    const r = await create({
      ...form,
      amount: Number(form.amount),
      status: 'Sent',
      invoice_type: form.invoice_type as 'one-time' | 'recurring',
    })
    if (r?.ok) { toast.success('Invoice created'); setShowForm(false); refetch() }
  }

  async function handlePartialPay(inv: { id: string; client_id: string; client_name: string }) {
    const amount = Number(payAmount)
    if (!amount || amount <= 0) { toast.error('Enter amount'); return }
    const r = await recordPay({
      invoice_id: inv.id,
      client_id: inv.client_id,
      client_name: inv.client_name,
      amount,
      payment_method: payMethod,
      payment_type: 'income',
    })
    if (r?.ok) {
      toast.success('Payment recorded')
      setPayId(null)
      setPayAmount('')
      refetch()
      if (previewInv?.id === inv.id) openPreview({ ...previewInv, ...inv } as CditInvoice)
    }
  }

  const invoices = data?.invoices ?? []
  const filteredInvoices = useMemo(
    () => invoices.filter(inv => inRangeYmd(invoiceYmd(inv), range.start, range.end)),
    [invoices, range.start, range.end],
  )

  return (
    <CditPageShell title="Invoices" subtitle={`${filteredInvoices.length} in ${rangeLabel} · ${invoices.length} loaded · premium PDF`} actions={
      mayAdmin ? (
        <Button variant="gold" onClick={() => setShowForm(s => !s)}>+ New Invoice</Button>
      ) : null
    }>
      <DateRangeFilter className="mb-3" />
      <Select value={status} onChange={setStatus} options={[
        { label: 'All', value: '' },
        { label: 'Unpaid', value: 'Unpaid' },
        { label: 'Partial Paid', value: 'Partial Paid' },
        { label: 'Paid', value: 'Paid' },
        { label: 'Sent', value: 'Sent' },
        { label: 'Draft', value: 'Draft' },
      ]} />

      {showForm && mayAdmin && (
        <Card className="p-5 space-y-3">
          <p className="text-sm font-bold text-cream">New Invoice</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input placeholder="Client name *" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.client_name} onChange={e => setForm(f => ({ ...f, client_name: e.target.value }))} />
            <input placeholder="Client ID (optional)" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} />
            <input placeholder="Amount (BDT) *" type="number" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            <select className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.invoice_type} onChange={e => setForm(f => ({ ...f, invoice_type: e.target.value }))}>
              <option value="one-time">One-time</option>
              <option value="recurring">Recurring</option>
            </select>
            <input type="date" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
          </div>
          <Button variant="gold" onClick={handleCreate} disabled={saving}>{saving ? 'Saving…' : 'Create Invoice'}</Button>
        </Card>
      )}

      <Card className="overflow-hidden">
        {loading ? <div className="p-4"><Skeleton className="h-32" /></div> : filteredInvoices.length === 0 ? (
          <div className="p-8"><Empty icon="◈" title="No invoices in range" desc="Adjust dates or create a new invoice" />
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredInvoices.map(inv => (
              <div key={inv.id} className="px-5 py-4 space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-mono text-[11px] text-gold font-bold w-24">{inv.id}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-cream">{inv.client_name}</p>
                    <p className="text-[10px] text-zinc-500">{inv.invoice_type} · Due {inv.due_date || '—'}</p>
                  </div>
                  <PaymentStatusBadge status={inv.payment_status} />
                  <span className="text-sm font-bold text-cream"><Money amount={inv.amount} /></span>
                  <span className="text-[10px] text-emerald-400">Paid <Money amount={inv.total_paid} /></span>
                  <span className="text-[10px] text-amber-400">Due <Money amount={inv.due_amount} /></span>
                  <Button variant="gold" size="xs" onClick={() => openPreview(inv)}>Preview PDF</Button>
                  {mayAdmin && inv.due_amount > 0 && (
                    <Button variant="ghost" size="xs" onClick={() => setPayId(payId === inv.id ? null : inv.id)}>
                      + Payment
                    </Button>
                  )}
                </div>
                {mayAdmin && payId === inv.id && (
                  <div className="flex gap-2 flex-wrap items-center pl-28">
                    <input type="number" placeholder="Amount" className="bg-card border border-border rounded-lg px-2 py-1 text-xs text-cream w-28" value={payAmount} onChange={e => setPayAmount(e.target.value)} />
                    <select className="bg-card border border-border rounded-lg px-2 py-1 text-xs text-cream" value={payMethod} onChange={e => setPayMethod(e.target.value)}>
                      {CDIT_PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <Button variant="gold" size="xs" disabled={paying} onClick={() => handlePartialPay(inv)}>Record</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <PdfPreviewModal
        open={!!previewInv && !!pdfModel}
        onClose={() => { setPreviewInv(null); setPreviewPayments([]) }}
        baseModel={pdfModel}
        shareSlug={previewInv ? shareSlugCdit(previewInv.id) : undefined}
      />
    </CditPageShell>
  )
}
