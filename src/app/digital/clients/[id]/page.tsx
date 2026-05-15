'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { CditPageShell } from '@/components/digital/CditPageShell'
import {
  PaymentProgressBar, PaymentStatusBadge, FinanceSummaryRow,
} from '@/components/digital/PaymentProgress'
import {
  useCditClientDetail, useCreateCditPayment, useCreateCditProject,
} from '@/hooks/useDigital'
import { Card, Button, Skeleton, Empty, Money, BdtText } from '@/components/ui'
import { CDIT_PAYMENT_METHODS, CDIT_SERVICES } from '@/types/cdit'
import { fmt } from '@/lib/utils'
import toast from 'react-hot-toast'

export default function CditClientDetailPage() {
  const params = useParams()
  const clientId = String(params.id || '')
  const { data, loading, refetch } = useCditClientDetail(clientId)
  const { mutate: recordPayment, loading: paying } = useCreateCditPayment()
  const { mutate: createProject, loading: creatingProject } = useCreateCditProject()

  const [showPay, setShowPay] = useState(false)
  const [showProject, setShowProject] = useState(false)
  const [payForm, setPayForm] = useState<{
    project_id: string; invoice_id: string; amount: string; payment_method: string
    transaction_id: string; payment_date: string; note: string
  }>({
    project_id: '', invoice_id: '', amount: '', payment_method: CDIT_PAYMENT_METHODS[0],
    transaction_id: '', payment_date: new Date().toISOString().slice(0, 10), note: '',
  })
  const [projForm, setProjForm] = useState<{
    project_name: string; service_type: string; total_amount: string; currency: string
    start_date: string; deadline: string; status: 'Active'; notes: string
  }>({
    project_name: '', service_type: CDIT_SERVICES[0], total_amount: '', currency: 'BDT',
    start_date: '', deadline: '', status: 'Active', notes: '',
  })

  const client = data?.client
  const summary = data?.summary
  const projects = data?.projects ?? []
  const timeline = data?.timeline ?? data?.payments ?? []

  async function handlePayment() {
    const amount = Number(payForm.amount)
    if (!amount || amount <= 0) { toast.error('Enter a valid amount'); return }
    const r = await recordPayment({
      client_id: clientId,
      client_name: client?.name,
      project_id: payForm.project_id,
      invoice_id: payForm.invoice_id,
      amount,
      payment_method: payForm.payment_method,
      transaction_id: payForm.transaction_id,
      payment_date: payForm.payment_date,
      note: payForm.note,
      payment_type: 'income',
      business_id: 'CREATIVE_DIGITAL_IT',
    })
    if (r?.ok) {
      toast.success(`Payment ${r.payment_id || ''} recorded`)
      setShowPay(false)
      setPayForm(f => ({ ...f, amount: '', transaction_id: '', note: '' }))
      refetch()
    } else toast.error('Could not record payment')
  }

  async function handleProject() {
    if (!projForm.project_name.trim()) { toast.error('Project name required'); return }
    const r = await createProject({
      client_id: clientId,
      client_name: client?.name,
      project_name: projForm.project_name,
      title: projForm.project_name,
      service_type: projForm.service_type,
      total_amount: Number(projForm.total_amount || 0),
      currency: projForm.currency,
      start_date: projForm.start_date,
      deadline: projForm.deadline,
      status: projForm.status,
      notes: projForm.notes,
      business_id: 'CREATIVE_DIGITAL_IT',
    })
    if (r?.ok) {
      toast.success(`Project ${r.project_id || ''} created`)
      setShowProject(false)
      refetch()
    }
  }

  if (loading) {
    return (
      <CditPageShell title="Client" subtitle="Loading…">
        <Skeleton className="h-48" />
      </CditPageShell>
    )
  }

  if (!client) {
    return (
      <CditPageShell title="Client not found">
        <Empty icon="◎" title="Client not found" desc={`No client with id ${clientId}`} />
        <Link href="/digital/clients" className="text-gold text-sm mt-4 inline-block">← Back to clients</Link>
      </CditPageShell>
    )
  }

  return (
    <CditPageShell
      title={client.name}
      subtitle={[client.company, client.id].filter(Boolean).join(' · ')}
      actions={
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowProject(s => !s)}>+ Project</Button>
          <Button variant="gold" size="sm" onClick={() => setShowPay(s => !s)}>+ Payment</Button>
        </div>
      }
    >
      <Link href="/digital/clients" className="text-[11px] text-zinc-500 hover:text-gold">← All clients</Link>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 md:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-cream">Billing summary</p>
            {summary && <PaymentStatusBadge status={summary.payment_status} />}
          </div>
          {summary && (
            <>
              <PaymentProgressBar percentage={summary.payment_percentage} status={summary.payment_status} />
              <FinanceSummaryRow label="Total project value" value={summary.total_amount} highlight="gold" />
              <FinanceSummaryRow label="Total paid" value={summary.total_paid} highlight="green" />
              <FinanceSummaryRow label="Due balance" value={summary.due_amount} highlight={summary.due_amount > 0 ? 'amber' : 'green'} />
            </>
          )}
        </Card>
        <Card className="p-5 space-y-2 text-sm">
          <p className="font-bold text-cream">Contact</p>
          <p className="text-zinc-400">{client.phone || '—'}</p>
          <p className="text-zinc-400">{client.email || '—'}</p>
          <p className="text-zinc-500 text-[11px]">{client.service_type} · {client.country}</p>
          {client.notes && <p className="text-[11px] text-zinc-500 mt-2">{client.notes}</p>}
        </Card>
      </div>

      {showPay && (
        <Card className="p-5 space-y-3">
          <p className="text-sm font-bold text-cream">Record payment</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <select className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={payForm.project_id} onChange={e => setPayForm(f => ({ ...f, project_id: e.target.value }))}>
              <option value="">Project (optional)</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {(p.project_name || p.title)} — due {fmt(p.due_amount)}
                </option>
              ))}
            </select>
            <input type="number" placeholder="Amount *" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={payForm.amount} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))} />
            <select className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={payForm.payment_method} onChange={e => setPayForm(f => ({ ...f, payment_method: e.target.value }))}>
              {CDIT_PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <input placeholder="Transaction ID" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={payForm.transaction_id} onChange={e => setPayForm(f => ({ ...f, transaction_id: e.target.value }))} />
            <input type="date" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={payForm.payment_date} onChange={e => setPayForm(f => ({ ...f, payment_date: e.target.value }))} />
            <input placeholder="Note" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream md:col-span-2" value={payForm.note} onChange={e => setPayForm(f => ({ ...f, note: e.target.value }))} />
          </div>
          <Button variant="gold" onClick={handlePayment} disabled={paying}>{paying ? 'Saving…' : 'Save payment'}</Button>
        </Card>
      )}

      {showProject && (
        <Card className="p-5 space-y-3">
          <p className="text-sm font-bold text-cream">New project</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input placeholder="Project name *" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream md:col-span-2" value={projForm.project_name} onChange={e => setProjForm(f => ({ ...f, project_name: e.target.value }))} />
            <input type="number" placeholder="Total amount (BDT)" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={projForm.total_amount} onChange={e => setProjForm(f => ({ ...f, total_amount: e.target.value }))} />
            <select className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={projForm.service_type} onChange={e => setProjForm(f => ({ ...f, service_type: e.target.value }))}>
              {CDIT_SERVICES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <input type="date" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={projForm.start_date} onChange={e => setProjForm(f => ({ ...f, start_date: e.target.value }))} />
            <input type="date" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={projForm.deadline} onChange={e => setProjForm(f => ({ ...f, deadline: e.target.value }))} />
          </div>
          <Button variant="gold" onClick={handleProject} disabled={creatingProject}>{creatingProject ? 'Saving…' : 'Create project'}</Button>
        </Card>
      )}

      <Card className="p-5">
        <p className="text-sm font-bold text-cream mb-4">Projects</p>
        {projects.length === 0 ? (
          <Empty icon="◰" title="No projects" desc="Add a project with a contract value" />
        ) : (
          <div className="space-y-4">
            {projects.map(pr => (
              <div key={pr.id} className="border border-border rounded-xl p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-cream">{pr.project_name || pr.title}</p>
                    <p className="text-[10px] text-zinc-500 font-mono">{pr.id} · {pr.status}</p>
                  </div>
                  <PaymentStatusBadge status={pr.payment_status} />
                </div>
                <PaymentProgressBar percentage={pr.payment_percentage} status={pr.payment_status} />
                <div className="flex gap-4 text-[11px] text-zinc-500">
                  <span>Value <Money amount={pr.total_amount} /></span>
                  <span className="text-emerald-400">Paid <Money amount={pr.total_paid} /></span>
                  <span className="text-amber-400">Due <Money amount={pr.due_amount} /></span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5 overflow-hidden">
        <p className="text-sm font-bold text-cream mb-4">Payment history</p>
        {timeline.length === 0 ? (
          <Empty icon="◈" title="No payments yet" desc="Record advance, milestone, or final payments" />
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-zinc-500 border-b border-border">
                <th className="py-2 pr-2">ID</th>
                <th className="py-2 pr-2">Date</th>
                <th className="py-2 pr-2">Method</th>
                <th className="py-2 pr-2">Reference</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map(pay => (
                <tr key={pay.id} className="border-b border-border/50 text-cream">
                  <td className="py-2 font-mono text-gold">{pay.id}</td>
                  <td className="py-2">{pay.payment_date || pay.date}</td>
                  <td className="py-2">{pay.payment_method || '—'}</td>
                  <td className="py-2 text-zinc-500">{pay.transaction_id || pay.note || '—'}</td>
                  <td className="py-2 text-right font-bold text-emerald-400"><Money amount={pay.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </CditPageShell>
  )
}
