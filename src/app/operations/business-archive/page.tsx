'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useSession } from 'next-auth/react'
import { useBusiness } from '@/contexts/BusinessContext'
import { BUSINESS_LIST } from '@/lib/businesses'
import { isSystemOwner } from '@/lib/roles'
import { Button, Card, Input, PageHeader, Select, Skeleton } from '@/components/ui'
import { useRouter } from 'next/navigation'

type ModuleDef = { key: string; label: string; description: string; storage: string }
type StatRow = { moduleKey: string; label: string; activeCount: number; archivedCount: number }
type PreviewModule = {
  moduleKey: string
  label: string
  count: number
  oldestAt: string | null
  newestAt: string | null
  storage: string
}
type BatchRow = {
  id: string
  name: string
  businessId: string
  moduleKeys: string[]
  status: string
  recordCount: number
  createdAt: string
  restoredAt: string | null
}

export default function BusinessArchiveControlPage() {
  const router = useRouter()
  const { data: session, status } = useSession()
  const { business, setBusinessId } = useBusiness()
  const allowed = status !== 'loading' && isSystemOwner(session)

  const [modules, setModules] = useState<ModuleDef[]>([])
  const [stats, setStats] = useState<StatRow[]>([])
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [batchName, setBatchName] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [expectedPhrase, setExpectedPhrase] = useState('')
  const [preview, setPreview] = useState<PreviewModule[] | null>(null)
  const [previewTotal, setPreviewTotal] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [mRes, bRes] = await Promise.all([
        fetch(`/api/business-archive/modules?business_id=${encodeURIComponent(business.id)}`, {
          cache: 'no-store',
        }),
        fetch(`/api/business-archive/batches?business_id=${encodeURIComponent(business.id)}`, {
          cache: 'no-store',
        }),
      ])
      const mj = await mRes.json().catch(() => ({}))
      const bj = await bRes.json().catch(() => ({}))
      if (!mRes.ok) throw new Error(mj.error || 'Failed to load modules')
      setModules(mj.modules || [])
      setStats(mj.stats || [])
      setBatches(bj.batches || [])
      setSelected([])
      setPreview(null)
      setConfirmation('')
      setExpectedPhrase('')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [business.id])

  useEffect(() => {
    if (!allowed) return
    void load()
  }, [allowed, load])

  useEffect(() => {
    if (status !== 'loading' && !allowed) router.replace('/')
  }, [status, allowed, router])

  function toggleModule(key: string) {
    setSelected(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]))
    setPreview(null)
    setExpectedPhrase('')
  }

  async function runPreview() {
    if (!selected.length) {
      toast.error('Select at least one module')
      return
    }
    setBusy('preview')
    try {
      const res = await fetch('/api/business-archive/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, module_keys: selected }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Preview failed')
      setPreview(j.preview?.modules || [])
      setPreviewTotal(j.preview?.totalRecords || 0)
      setExpectedPhrase(j.confirmationPhrase || '')
      toast.success('Dry run ready — review counts below')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function runArchive() {
    if (!selected.length || !batchName.trim()) {
      toast.error('Batch name and modules required')
      return
    }
    if (!confirmation.trim()) {
      toast.error('Type the confirmation phrase exactly')
      return
    }
    setBusy('archive')
    try {
      const res = await fetch('/api/business-archive/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          module_keys: selected,
          batch_name: batchName,
          confirmation,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Archive failed')
      toast.success(`Archived ${j.recordCount} records (soft archive — recoverable)`)
      setConfirmation('')
      setPreview(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function restoreBatch(id: string) {
    if (!confirm('Restore all records in this archive batch?')) return
    setBusy(`restore-${id}`)
    try {
      const res = await fetch('/api/business-archive/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: id }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Restore failed')
      toast.success(`Restored ${j.restored} records`)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (status === 'loading' || !allowed) {
    return (
      <div className="p-8">
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Business Archive Control"
        subtitle="Soft archive only — data stays in the database. Hide from active workspace; restore anytime."
      />

      <Card className="border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
        <p className="font-black">Safety mode</p>
        <p className="mt-1 text-xs text-amber-100/90">
          This never permanently deletes records. Archived items are hidden from default views. Use
          <code className="mx-1 rounded bg-black/30 px-1">archive_visibility=archived</code> on APIs or Show Archived in UI.
        </p>
      </Card>

      <Card className="p-5 border-gold-dim/25 space-y-4">
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Step 1 · Business</p>
        <Select
          value={business.id}
          onChange={v => {
            const b = BUSINESS_LIST.find(x => x.id === v)
            if (b) setBusinessId(b.id)
          }}
          options={BUSINESS_LIST.map(b => ({ label: b.name, value: b.id }))}
        />
      </Card>

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <Card className="p-5 space-y-3">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">
              Active vs archived stats
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {stats.map(s => (
                <div key={s.moduleKey} className="rounded-xl border border-border bg-black/25 px-3 py-2 text-[11px]">
                  <p className="font-bold text-cream">{s.label}</p>
                  <p className="mt-1 text-zinc-500">
                    Active <span className="text-green-400">{s.activeCount}</span> · Archived{' '}
                    <span className="text-amber-300">{s.archivedCount}</span>
                  </p>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-5 space-y-4 border-gold-dim/20">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">
              Step 2–3 · Select modules
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {modules.map(m => (
                <label
                  key={m.key}
                  className={`flex cursor-pointer gap-3 rounded-xl border px-3 py-2.5 text-xs transition ${
                    selected.includes(m.key)
                      ? 'border-gold/50 bg-gold/10'
                      : 'border-border bg-black/20 hover:border-zinc-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(m.key)}
                    onChange={() => toggleModule(m.key)}
                  />
                  <span>
                    <span className="font-bold text-cream">{m.label}</span>
                    <span className="mt-0.5 block text-zinc-500">{m.description}</span>
                    <span className="text-[10px] text-zinc-600">{m.storage}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={busy !== null} onClick={() => void runPreview()}>
                {busy === 'preview' ? 'Previewing…' : 'Step 4 · Dry run preview'}
              </Button>
            </div>
          </Card>

          {preview && (
            <Card className="p-5 border-amber-500/25 bg-amber-500/5 space-y-3">
              <p className="text-sm font-black text-amber-100">
                Dry run · {previewTotal.toLocaleString()} records would be archived
              </p>
              <ul className="space-y-2 text-[11px]">
                {preview.map(p => (
                  <li key={p.moduleKey} className="flex justify-between gap-4 border-b border-border/50 py-2">
                    <span className="text-cream">
                      {p.label}{' '}
                      <span className="text-zinc-600">({p.storage})</span>
                    </span>
                    <span className="font-mono text-amber-200">{p.count}</span>
                  </li>
                ))}
              </ul>
              <Input
                placeholder="Batch name (e.g. Lifestyle Reset May 2026)"
                value={batchName}
                onChange={e => setBatchName(e.target.value)}
              />
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3">
                <p className="text-[10px] font-bold text-red-200">Step 5 · Type to confirm</p>
                <p className="mt-1 font-mono text-xs text-red-100 break-all">{expectedPhrase}</p>
                <Input
                  className="mt-3"
                  placeholder="Type confirmation phrase exactly"
                  value={confirmation}
                  onChange={e => setConfirmation(e.target.value)}
                />
              </div>
              <Button
                variant="gold"
                disabled={busy !== null || confirmation.trim().toUpperCase() !== expectedPhrase}
                onClick={() => void runArchive()}
              >
                {busy === 'archive' ? 'Archiving…' : 'Execute soft archive'}
              </Button>
            </Card>
          )}

          <Card className="p-5 space-y-3">
            <p className="text-sm font-bold text-cream">Archive history</p>
            {!batches.length ? (
              <p className="text-xs text-zinc-500">No archive batches yet.</p>
            ) : (
              <ul className="space-y-2">
                {batches.map(b => (
                  <li
                    key={b.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-black/20 px-3 py-2 text-[11px]"
                  >
                    <span>
                      <span className="font-bold text-cream">{b.name}</span>
                      <span className="mt-0.5 block text-zinc-500">
                        {b.moduleKeys.join(', ')} · {b.recordCount} records · {b.status}
                      </span>
                      <span className="text-zinc-600">{new Date(b.createdAt).toLocaleString()}</span>
                    </span>
                    {b.status === 'COMPLETED' && (
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => void restoreBatch(b.id)}
                      >
                        {busy === `restore-${b.id}` ? 'Restoring…' : 'Restore batch'}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
