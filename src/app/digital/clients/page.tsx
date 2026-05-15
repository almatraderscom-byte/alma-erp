'use client'
import { useState } from 'react'
import Link from 'next/link'
import { CditPageShell } from '@/components/digital/CditPageShell'
import { useCditClients, useCreateCditClient } from '@/hooks/useDigital'
import { Card, Button, SearchInput, Skeleton, Empty } from '@/components/ui'
import { CDIT_SERVICES } from '@/types/cdit'
import toast from 'react-hot-toast'

export default function DigitalClientsPage() {
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({
    name: '', company: '', phone: '', email: '', country: 'Bangladesh',
    service_type: CDIT_SERVICES[0] as string, lead_source: '', notes: '', tags: '',
  })
  const { data, loading, refetch } = useCditClients(search)
  const { mutate: create, loading: saving, error: saveError } = useCreateCditClient()

  async function handleCreate() {
    if (!form.name.trim()) { toast.error('Client name required'); return }
    const payload = {
      ...form,
      name: form.name.trim(),
      business_id: 'CREATIVE_DIGITAL_IT' as const,
    }
    console.log('[CDIT Client] create payload:', payload)
    const r = await create(payload)
    console.log('[CDIT Client] create response:', r, 'mutation error:', saveError)
    if (r?.ok) {
      toast.success(`Client ${r.client_id || r.client?.id || ''} saved`)
      setShowForm(false)
      setForm({
        name: '', company: '', phone: '', email: '', country: 'Bangladesh',
        service_type: CDIT_SERVICES[0] as string, lead_source: '', notes: '', tags: '',
      })
      refetch()
      return
    }
    toast.error(saveError || (r as { error?: string } | null)?.error || 'Could not create client')
  }

  const clients = data?.clients ?? []

  return (
    <CditPageShell
      title="Client CRM"
      subtitle={`${clients.length} clients`}
      actions={<Button variant="gold" onClick={() => setShowForm(s => !s)}>+ Add Client</Button>}
    >
      <SearchInput value={search} onChange={setSearch} placeholder="Search clients…" />

      {showForm && (
        <Card className="p-5 space-y-3">
          <p className="text-sm font-bold text-cream">New Client</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(['name', 'company', 'phone', 'email', 'country', 'lead_source', 'tags'] as const).map(k => (
              <label key={k} className="block">
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{k}</span>
                <input
                  className="mt-1 w-full bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream"
                  value={form[k]}
                  onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                />
              </label>
            ))}
            <label className="block md:col-span-2">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Service type</span>
              <select
                className="mt-1 w-full bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream"
                value={form.service_type}
                onChange={e => setForm(f => ({ ...f, service_type: e.target.value }))}
              >
                {CDIT_SERVICES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Notes</span>
            <textarea
              className="mt-1 w-full bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream min-h-[72px]"
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            />
          </label>
          <Button variant="gold" onClick={handleCreate} disabled={saving}>
            {saving ? 'Saving…' : 'Save Client'}
          </Button>
        </Card>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-4"><Skeleton className="h-32" /></div>
        ) : clients.length === 0 ? (
          <div className="p-8"><Empty icon="◎" title="No clients yet" desc="Add your first agency client" /></div>
        ) : (
          <div className="divide-y divide-border">
            {clients.map(c => (
              <Link key={c.id} href={`/digital/clients/${c.id}`} className="block px-5 py-4 hover:bg-white/[0.02]">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-cream">{c.name}</p>
                    <p className="text-[11px] text-zinc-500">{c.company || '—'} · {c.service_type}</p>
                    <p className="text-[11px] text-zinc-600 font-mono mt-1">{c.phone} · {c.email}</p>
                  </div>
                  <span className="font-mono text-[10px] text-gold">{c.id}</span>
                </div>
                {c.notes && <p className="text-[11px] text-zinc-500 mt-2 line-clamp-2">{c.notes}</p>}
              </Link>
            ))}
          </div>
        )}
      </Card>
    </CditPageShell>
  )
}
