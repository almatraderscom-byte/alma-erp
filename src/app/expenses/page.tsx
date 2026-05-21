'use client'
import { useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { useFinance } from '@/hooks/useERP'
import { useAddExpense } from '@/hooks/useERP'
import { EXPENSE_CATEGORIES } from '@/lib/expense-categories'
import { Card, Button, KpiCard, Skeleton, Empty } from '@/components/ui'
import { DonutChart } from '@/components/charts'
import { pdf } from '@react-pdf/renderer'
import { ExpenseLedgerDocument } from '@/components/pdf/ExpenseLedgerDocument'
import { expensesToCsv, expensesToWorkbook, downloadBlob } from '@/lib/export-expenses'
import { useBusiness } from '@/contexts/BusinessContext'
import { useActor } from '@/contexts/ActorContext'
import { useDateRange } from '@/contexts/DateRangeContext'
import { can } from '@/lib/roles'
import toast from 'react-hot-toast'

const PALETTE = ['#C9A84C','#8B6914','#E8C96A','#6B5530','#4A3A20','#3D3020','#2a1a08']
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024

type ReceiptUpload = {
  id: string
  url: string
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedAt: string
  uploadedByName?: string | null
}

function categoryDonut(by: Record<string, number>) {
  const arr = Object.entries(by).sort((a, b) => b[1] - a[1])
  return arr.map(([name, value], i) => ({ name, value, color: PALETTE[i % PALETTE.length] }))
}

export default function ExpensesPage() {
  const { business } = useBusiness()
  const { role } = useActor()
  const mayExpense = can(role, 'expenseWrite')
  const { label } = useDateRange()
  const { data, loading, refetch } = useFinance()
  const { mutate: addEx, loading: saving } = useAddExpense()
  const [open, setOpen] = useState(false)
  const [receipt, setReceipt] = useState<ReceiptUpload | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const expenses = data?.expenses ?? []
  const total = data?.total_expenses ?? 0
  const byCat = data?.by_category ?? {}
  const donut = useMemo(() => categoryDonut(byCat), [byCat])

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const payload = {
      title: String(fd.get('title') || ''),
      category: String(fd.get('category') || ''),
      amount: Number(fd.get('amount') || 0),
      payment_status: String(fd.get('payment_status') || 'Paid'),
      payment_method: String(fd.get('payment_method') || ''),
      notes: String(fd.get('notes') || ''),
      recurring: fd.get('recurring') === 'on',
      receipt_ref: receipt?.url || '',
      receipt_attachment_id: receipt?.id,
      date: String(fd.get('date') || '') || undefined,
    }
    if (!payload.category || !payload.amount) {
      toast.error('Category and amount are required')
      return
    }
    const res = await addEx(payload)
    if (res?.ok) {
      toast.success('Expense recorded')
      setOpen(false)
      setReceipt(null)
      refetch()
      e.currentTarget.reset()
    }
  }

  async function uploadReceipt(file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].includes(file.type)) {
      toast.error('Upload an image or PDF receipt only')
      return
    }
    if (file.size > MAX_RECEIPT_BYTES) {
      toast.error('Receipt must be 10 MB or smaller')
      return
    }
    setUploading(true)
    setUploadProgress(15)
    try {
      const form = new FormData()
      form.set('file', file)
      form.set('business_id', business.id)
      const timer = window.setInterval(() => setUploadProgress(p => Math.min(90, p + 12)), 250)
      const res = await fetch('/api/finance/receipts', { method: 'POST', body: form })
      window.clearInterval(timer)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Receipt upload failed')
      setReceipt(j.attachment as ReceiptUpload)
      setUploadProgress(100)
      toast.success('Receipt uploaded')
    } catch (e) {
      toast.error((e as Error).message)
      setUploadProgress(0)
    } finally {
      setUploading(false)
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void uploadReceipt(file)
  }

  function openReceipt(url?: string) {
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function exportPdf() {
    const blob = await pdf(
      <ExpenseLedgerDocument title="Expense ledger" businessLabel={business.name} rangeLabel={label} rows={expenses} total={total} />,
    ).toBlob()
    downloadBlob(`expenses-${label.replace(/\s+/g, '-')}.pdf`, blob)
  }

  async function exportCsv() {
    downloadBlob(`expenses-${label}.csv`, new Blob([expensesToCsv(expenses)], { type: 'text/csv;charset=utf-8' }))
  }

  async function exportXlsx() {
    const buf = await expensesToWorkbook(expenses)
    downloadBlob(`expenses-${label}.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  }

  return (
    <FinancePageChrome
      title="Expenses"
      subtitle="Operational spend · approvals · attachments"
      actions={(
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="secondary" disabled={loading || !expenses.length} onClick={() => void exportPdf()}>PDF</Button>
          <Button size="xs" variant="secondary" disabled={loading || !expenses.length} onClick={() => exportCsv()}>CSV</Button>
          <Button size="xs" variant="secondary" disabled={loading || !expenses.length} onClick={() => void exportXlsx()}>Excel</Button>
          {mayExpense ? (
            <Button size="xs" variant="gold" onClick={() => setOpen(true)}>+ Add expense</Button>
          ) : null}
        </div>
      )}
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Total expenses (range)" value={loading ? '—' : total} loading={loading} />
        <KpiCard label="Ledger cash readout" value={loading ? '—' : Number(data?.cash_balance ?? 0)} loading={loading} />
        <KpiCard label="Line items" value={loading ? '—' : expenses.length} loading={loading} />
        <KpiCard label="Active categories" value={loading ? '—' : Object.keys(byCat).length} loading={loading} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-5">
          <p className="text-sm font-bold text-cream mb-4">Expense mix</p>
          {loading ? <Skeleton className="h-52" /> : donut.length === 0 ? (
            <Empty icon="◫" title="No expenses" desc="Relax filters or capture your first receipt" />
          ) : (
            <DonutChart data={donut} />
          )}
        </Card>
        <Card className="p-5 overflow-hidden">
          <p className="text-sm font-bold text-cream mb-4">Highest categories</p>
          {loading ? <Skeleton className="h-52" /> : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([cat, amt]) => (
                <div key={cat} className="flex justify-between text-xs border-b border-border/60 pb-2">
                  <span className="text-zinc-400">{cat}</span>
                  <span className="text-gold font-mono">৳ {amt.toLocaleString('en-BD')}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-5 overflow-hidden">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-bold text-cream">Ledger lines</p>
            <p className="text-[10px] text-zinc-500">{label}</p>
          </div>
        </div>
        {loading ? <Skeleton className="h-48" /> : expenses.length === 0 ? (
          <Empty icon="◫" title="No rows" />
        ) : (
          <div className="table-scroll max-h-[480px]">
            <table className="w-full min-w-[760px] text-left text-[11px]">
              <thead className="sticky top-0 bg-card border-b border-border">
                <tr className="text-zinc-500">
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Title</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3 text-right">৳</th>
                  <th className="py-2 pr-3">Receipt</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map(er => (
                  <tr key={er.exp_id + er.date + er.amount} className="border-b border-border/60">
                    <td className="py-2 pr-3 font-mono text-zinc-400">{er.date.slice(0, 10)}</td>
                    <td className="py-2 pr-3 text-cream">{er.title}</td>
                    <td className="py-2 pr-3">{er.category}</td>
                    <td className="py-2 pr-3 text-right font-mono text-gold-lt">{er.amount.toLocaleString('en-BD')}</td>
                    <td className="py-2 pr-3">
                      {er.receipt_ref ? (
                        <button type="button" onClick={() => openReceipt(er.receipt_ref)} className="rounded-full border border-green-400/25 bg-green-400/10 px-2 py-0.5 text-[9px] font-bold text-green-400">
                          Attachment
                        </button>
                      ) : <span className="text-zinc-700">—</span>}
                    </td>
                    <td className="py-2 text-zinc-500">{er.payment_status ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <div className="fixed inset-0 z-[121] flex items-end md:items-center justify-center p-4 pointer-events-none">
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.98 }}
                transition={{ type: 'spring', damping: 26, stiffness: 320 }}
                className="pointer-events-auto w-full max-w-lg"
              >
                <Card className="p-5 border-gold-dim/30 max-h-[90dvh] overflow-y-auto scrollbar-hide">
                  <p className="text-sm font-bold text-cream mb-4">Add expense</p>
                  <form onSubmit={submit} className="space-y-3 text-xs">
                    <label className="block space-y-1">
                      <span className="text-zinc-500">Title</span>
                      <input name="title" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm" />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-zinc-500">Category</span>
                      <select name="category" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm">
                        <option value="">Select…</option>
                        {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block space-y-1">
                        <span className="text-zinc-500">Amount (৳)</span>
                        <input name="amount" type="number" step="0.01" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream font-mono text-sm" />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-zinc-500">Payment date</span>
                        <input name="date" type="date" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream font-mono text-sm" />
                      </label>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block space-y-1">
                        <span className="text-zinc-500">Payment status</span>
                        <select name="payment_status" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm">
                          <option>Paid</option>
                          <option>Pending</option>
                          <option>Partial</option>
                        </select>
                      </label>
                      <label className="block space-y-1">
                        <span className="text-zinc-500">Payment method</span>
                        <input name="payment_method" placeholder="bKash, bank…" className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm" />
                      </label>
                    </div>
                    <label className="flex items-center gap-2 text-zinc-400">
                      <input name="recurring" type="checkbox" className="rounded border-border" /> Recurring
                    </label>
                    <div className="space-y-2">
                      <span className="text-zinc-500">Receipt / document</span>
                      <div
                        onDragOver={e => { e.preventDefault(); setDragActive(true) }}
                        onDragLeave={() => setDragActive(false)}
                        onDrop={handleDrop}
                        className={`rounded-2xl border border-dashed p-4 text-center transition-colors ${dragActive ? 'border-gold-dim/70 bg-gold/10' : 'border-border bg-black/20'}`}
                      >
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*,application/pdf"
                          capture="environment"
                          className="hidden"
                          onChange={e => {
                            const file = e.currentTarget.files?.[0]
                            if (file) void uploadReceipt(file)
                            e.currentTarget.value = ''
                          }}
                        />
                        {receipt ? (
                          <div className="space-y-2">
                            {receipt.contentType.startsWith('image/') ? (
                              <button type="button" onClick={() => openReceipt(receipt.url)} className="mx-auto block overflow-hidden rounded-xl border border-border">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={receipt.url} alt="Receipt preview" className="max-h-36 max-w-full object-contain" />
                              </button>
                            ) : (
                              <button type="button" onClick={() => openReceipt(receipt.url)} className="rounded-xl border border-border bg-card px-4 py-3 text-xs font-bold text-gold-lt">
                                PDF receipt · open/download
                              </button>
                            )}
                            <p className="text-[10px] text-zinc-500">{receipt.fileName} · {(receipt.sizeBytes / 1024).toFixed(1)} KB</p>
                            <div className="flex justify-center gap-2">
                              <Button size="xs" variant="secondary" type="button" onClick={() => openReceipt(receipt.url)}>Preview</Button>
                              <Button size="xs" variant="ghost" type="button" onClick={() => setReceipt(null)}>Remove</Button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <p className="text-xs text-zinc-400">Drop receipt here, or upload/capture from mobile camera.</p>
                            <p className="text-[10px] text-zinc-600">Images, screenshots, invoice scans, and PDF up to 10 MB.</p>
                            <Button size="xs" variant="gold" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                              {uploading ? 'Uploading…' : 'Upload receipt'}
                            </Button>
                            {uploading && <div className="h-1.5 rounded-full bg-border overflow-hidden"><div className="h-full bg-gold" style={{ width: `${uploadProgress}%` }} /></div>}
                          </div>
                        )}
                      </div>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-zinc-500">Notes</span>
                      <textarea name="notes" rows={3} className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm" />
                    </label>
                    <div className="flex gap-2 pt-2">
                      <Button type="submit" variant="gold" disabled={saving}>{saving ? 'Saving…' : 'Save expense'}</Button>
                      <Button type="button" variant="ghost" onClick={() => { setOpen(false); setReceipt(null) }}>Cancel</Button>
                    </div>
                  </form>
                </Card>
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </FinancePageChrome>
  )
}
