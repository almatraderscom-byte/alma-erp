'use client'
import { useState } from 'react'
import Link from 'next/link'
import { CditPageShell } from '@/components/digital/CditPageShell'
import { PaymentProgressBar, PaymentStatusBadge } from '@/components/digital/PaymentProgress'
import { useCditProjects, useCreateCditProject } from '@/hooks/useDigital'
import { Card, Button, SearchInput, Skeleton, Empty, Select, Money, BdtText } from '@/components/ui'
import { CDIT_SERVICES } from '@/types/cdit'
import type { CditProjectStatus, CditPriority } from '@/types/cdit'
import { fmt } from '@/lib/utils'
import toast from 'react-hot-toast'

const STATUSES: CditProjectStatus[] = ['Lead', 'Proposal', 'Active', 'Review', 'Completed', 'On Hold', 'Cancelled']
const PRIORITIES: CditPriority[] = ['Low', 'Medium', 'High', 'Urgent']

export default function DigitalProjectsPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    project_name: '', title: '', client_id: '', client_name: '', service_type: CDIT_SERVICES[0] as string,
    total_amount: '', currency: 'BDT', start_date: '',
    status: 'Lead' as CditProjectStatus, deadline: '', assigned_to: '', priority: 'Medium' as CditPriority,
  })
  const { data, loading, refetch } = useCditProjects({ status: status || undefined, search })
  const { mutate: create, loading: saving } = useCreateCditProject()

  async function handleCreate() {
    const name = form.project_name.trim() || form.title.trim()
    if (!name) { toast.error('Project name required'); return }
    const r = await create({
      ...form,
      project_name: name,
      title: name,
      total_amount: Number(form.total_amount || 0),
      business_id: 'CREATIVE_DIGITAL_IT',
    })
    if (r?.ok) { toast.success('Project created'); setShowForm(false); refetch() }
    else toast.error('Could not create project')
  }

  const projects = data?.projects ?? []

  return (
    <CditPageShell title="Projects" subtitle={`${projects.length} projects · billing tracked`} actions={
      <Button variant="gold" onClick={() => setShowForm(s => !s)}>+ New Project</Button>
    }>
      <div className="flex flex-wrap gap-2">
        <div className="flex-1 min-w-48"><SearchInput value={search} onChange={setSearch} placeholder="Search projects…" /></div>
        <Select value={status} onChange={setStatus} options={[{ label: 'All status', value: '' }, ...STATUSES.map(s => ({ label: s, value: s }))]} />
      </div>
      {showForm && (
        <Card className="p-5 space-y-3">
          <p className="text-sm font-bold text-cream">New Project</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input placeholder="Project name *" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream md:col-span-2" value={form.project_name} onChange={e => setForm(f => ({ ...f, project_name: e.target.value, title: e.target.value }))} />
            <input placeholder="Client ID" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} />
            <input placeholder="Client name" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.client_name} onChange={e => setForm(f => ({ ...f, client_name: e.target.value }))} />
            <input type="number" placeholder="Contract value (BDT)" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.total_amount} onChange={e => setForm(f => ({ ...f, total_amount: e.target.value }))} />
            <select className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.service_type} onChange={e => setForm(f => ({ ...f, service_type: e.target.value }))}>
              {CDIT_SERVICES.map(s => <option key={s}>{s}</option>)}
            </select>
            <input type="date" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
            <input type="date" className="bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream" value={form.deadline} onChange={e => setForm(f => ({ ...f, deadline: e.target.value }))} />
          </div>
          <Button variant="gold" onClick={handleCreate} disabled={saving}>{saving ? 'Saving…' : 'Create Project'}</Button>
        </Card>
      )}
      <Card className="overflow-hidden">
        {loading ? <div className="p-4"><Skeleton className="h-32" /></div> : projects.length === 0 ? (
          <div className="p-8"><Empty icon="◰" title="No projects" desc="Start tracking client work here" /></div>
        ) : (
          <div className="divide-y divide-border">
            {projects.map(p => (
              <div key={p.id} className="px-5 py-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-cream">{p.project_name || p.title}</p>
                    <p className="text-[11px] text-zinc-500">{p.client_name} · {p.service_type}</p>
                    {p.client_id && (
                      <Link href={`/digital/clients/${p.client_id}`} className="text-[10px] text-gold hover:underline">
                        View client →
                      </Link>
                    )}
                  </div>
                  <PaymentStatusBadge status={p.payment_status} />
                </div>
                <PaymentProgressBar percentage={p.payment_percentage} status={p.payment_status} />
                <div className="flex gap-4 text-[10px] text-zinc-500">
                  <span>Value <Money amount={p.total_amount} /></span>
                  <span className="text-emerald-400">Paid <Money amount={p.total_paid} /></span>
                  <span className="text-amber-400">Due <Money amount={p.due_amount} /></span>
                  <span>{p.status} · Due {p.deadline || '—'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </CditPageShell>
  )
}
