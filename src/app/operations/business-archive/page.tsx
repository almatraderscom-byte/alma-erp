'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { safeFetchJsonWithToast } from '@/lib/safe-fetch'
import { unwrapApiData } from '@/lib/safe-api-response'
import { useSession } from 'next-auth/react'
import { useBusiness } from '@/contexts/BusinessContext'
import { BUSINESS_LIST } from '@/lib/businesses'
import { modulesForBusiness, type ArchiveModuleDef } from '@/lib/business-archive/module-registry'
import { isSystemOwner } from '@/lib/roles'
import { Button, Card, Input, PageHeader, Select, Skeleton } from '@/components/ui'
import { useRouter } from 'next/navigation'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25 } } }

type ModuleDef = { key: string; label: string; description: string; storage: string }
type StatRow = {
  moduleKey: string
  label: string
  activeCount: number
  archivedCount: number
  available?: boolean
  warning?: string | null
}
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
  const [schemaReady, setSchemaReady] = useState(true)
  const [migrationHint, setMigrationHint] = useState<string | null>(null)
  const [loadWarning, setLoadWarning] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadWarning(null)
    const fallbackModules = modulesForBusiness(business.id)

    try {
      const [mResult, bResult] = await Promise.all([
        safeFetchJsonWithToast<Record<string, unknown>>(
          `/api/business-archive/modules?business_id=${encodeURIComponent(business.id)}`,
          { cache: 'no-store', toastOnError: false },
        ),
        safeFetchJsonWithToast<Record<string, unknown>>(
          `/api/business-archive/batches?business_id=${encodeURIComponent(business.id)}`,
          { cache: 'no-store', toastOnError: false },
        ),
      ])

      if (mResult.status === 401) {
        setLoadWarning('Session expired — sign in again.')
        return
      }
      if (mResult.status === 403) {
        setLoadWarning('Super Admin access required for Archive Control.')
        return
      }

      const mj = mResult.ok ? unwrapApiData<Record<string, unknown>>(mResult.data as Record<string, unknown>) : {}
      const bj = bResult.ok ? unwrapApiData<Record<string, unknown>>(bResult.data as Record<string, unknown>) : {}

      const modulesList = (mj.modules as ArchiveModuleDef[] | undefined)?.length
        ? (mj.modules as ArchiveModuleDef[])
        : fallbackModules
      setModules(modulesList)
      setStats(
        (mj.stats as StatRow[] | undefined)?.length
          ? (mj.stats as StatRow[])
          : modulesList.map((m: ArchiveModuleDef) => ({
              moduleKey: m.key,
              label: m.label,
              activeCount: 0,
              archivedCount: 0,
              available: m.key !== 'crm' && m.key !== 'inventory',
              warning: m.integrationNote ?? null,
            })),
      )
      setSchemaReady(mj.schemaReady !== false)
      setMigrationHint((mj.migrationHint as string | null) || null)
      setBatches((bj.batches as BatchRow[]) || [])

      const warn =
        (mj.warning as string | undefined) ||
        (!mResult.ok ? mResult.error.message : null) ||
        (mj.partialFailure ? 'Some modules could not load live stats.' : null) ||
        (!mResult.ok ? 'Archive API returned a degraded response.' : null)
      setLoadWarning(warn)

      if (warn) toast.error(warn, { id: 'archive-load-warn' })
      else toast.dismiss('archive-load-warn')

      setSelected([])
      setPreview(null)
      setConfirmation('')
      setExpectedPhrase('')
    } catch (e) {
      const msg = (e as Error).message || 'Network error loading archive modules'
      setModules(fallbackModules)
      setStats(
        fallbackModules.map(m => ({
          moduleKey: m.key,
          label: m.label,
          activeCount: 0,
          archivedCount: 0,
          available: false,
          warning: m.integrationNote || 'Offline fallback',
        })),
      )
      setLoadWarning(msg)
      toast.error(msg)
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
      const result = await safeFetchJsonWithToast<{
        preview?: { modules?: unknown[]; totalRecords?: number }
        confirmationPhrase?: string
        warning?: string
      }>('/api/business-archive/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, module_keys: selected }),
      })
      if (!result.ok) throw new Error(result.error.message)
      const j = result.data
      if (j.warning) throw new Error(j.warning)
      setPreview((j.preview?.modules as typeof preview) || [])
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
      const result = await safeFetchJsonWithToast<{ recordCount?: number }>('/api/business-archive/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          module_keys: selected,
          batch_name: batchName,
          confirmation,
        }),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success(`Archived ${result.data.recordCount ?? 0} records (soft archive — recoverable)`)
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
      const result = await safeFetchJsonWithToast<{ restored?: number }>('/api/business-archive/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: id }),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success(`Restored ${result.data.restored ?? 0} records`)
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
    <div className="min-h-screen bg-[#FAF9F6]">
      <PageHeader
        title="Business Archive Control"
        subtitle="Soft archive only — data stays in the database. Hide from active workspace; restore anytime."
      />

      <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-5 px-3 py-4 pb-24 sm:px-6 md:pb-6">
        {loadWarning && (
          <motion.div variants={fadeUp}>
            <Card className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 flex flex-wrap items-center justify-between gap-3">
              <p>{loadWarning}</p>
              <Button size="xs" variant="secondary" onClick={() => void load()}>Retry</Button>
            </Card>
          </motion.div>
        )}

        {!schemaReady && (
          <motion.div variants={fadeUp}>
            <Card className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <p className="font-bold">Database migration required</p>
              <p className="mt-1 text-xs">
                {migrationHint || 'Business Archive tables are not on this database yet.'} ERP continues
                normally; run migrations on production to enable archive features.
              </p>
            </Card>
          </motion.div>
        )}

        <motion.div variants={fadeUp}>
          <Card className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 text-sm text-amber-800">
            <p className="font-bold">Safety mode</p>
            <p className="mt-1 text-xs text-amber-700">
              This never permanently deletes records. Archived items are hidden from default views. Use
              <code className="mx-1 rounded bg-amber-100 px-1 text-amber-900">archive_visibility=archived</code> on APIs or Show Archived in UI.
            </p>
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card className="rounded-2xl border border-black/[0.06] p-5 space-y-4 shadow-sm">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#E07A5F]">Step 1 · Business</p>
            <Select
              value={business.id}
              onChange={v => {
                const b = BUSINESS_LIST.find(x => x.id === v)
                if (b) setBusinessId(b.id)
              }}
              options={BUSINESS_LIST.map(b => ({ label: b.name, value: b.id }))}
            />
          </Card>
        </motion.div>

        {loading ? (
          <Skeleton className="h-64 w-full rounded-2xl" />
        ) : (
          <>
            <motion.div variants={fadeUp}>
              <Card className="rounded-2xl border border-black/[0.06] p-5 space-y-3 shadow-sm">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#E07A5F]">
                  Active vs archived stats
                </p>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {stats.map(s => (
                    <div key={s.moduleKey} className="rounded-xl border border-black/[0.06] bg-white px-4 py-3 text-[11px]">
                      <p className="font-bold text-slate-800">{s.label}</p>
                      <p className="mt-1 text-slate-500">
                        Active <span className="font-semibold text-emerald-600">{s.activeCount}</span> · Archived{' '}
                        <span className="font-semibold text-amber-600">{s.archivedCount}</span>
                      </p>
                    </div>
                  ))}
                </div>
              </Card>
            </motion.div>

            <motion.div variants={fadeUp}>
              <Card className="rounded-2xl border border-black/[0.06] p-5 space-y-4 shadow-sm">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#E07A5F]">
                  Step 2–3 · Select modules
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {modules.map(m => {
                    const stat = stats.find(s => s.moduleKey === m.key)
                    const unavailable = stat?.available === false
                    return (
                      <label
                        key={m.key}
                        className={`flex gap-3 rounded-xl border px-4 py-3 text-xs transition ${
                          unavailable
                            ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-70'
                            : selected.includes(m.key)
                              ? 'cursor-pointer border-[#E07A5F]/40 bg-[#E07A5F]/5'
                              : 'cursor-pointer border-black/[0.06] bg-white hover:border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={unavailable}
                          checked={selected.includes(m.key)}
                          onChange={() => !unavailable && toggleModule(m.key)}
                          className="mt-0.5 accent-[#E07A5F]"
                        />
                        <span>
                          <span className="font-bold text-slate-800">{m.label}</span>
                          <span className="mt-0.5 block text-slate-500">{m.description}</span>
                          <span className="text-[10px] text-slate-400">{m.storage}</span>
                          {stat?.warning && (
                            <span className="mt-1 block text-[10px] text-amber-600">{stat.warning}</span>
                          )}
                        </span>
                      </label>
                    )
                  })}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" disabled={busy !== null} onClick={() => void runPreview()}>
                    {busy === 'preview' ? 'Previewing…' : 'Step 4 · Dry run preview'}
                  </Button>
                </div>
              </Card>
            </motion.div>

            {preview && (
              <motion.div variants={fadeUp}>
                <Card className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5 space-y-3">
                  <p className="text-sm font-bold text-amber-800">
                    Dry run · {previewTotal.toLocaleString()} records would be archived
                  </p>
                  <ul className="space-y-2 text-[11px]">
                    {preview.map(p => (
                      <li key={p.moduleKey} className="flex justify-between gap-4 border-b border-amber-200/50 py-2">
                        <span className="text-slate-800">
                          {p.label}{' '}
                          <span className="text-slate-400">({p.storage})</span>
                        </span>
                        <span className="font-mono font-bold text-amber-700">{p.count}</span>
                      </li>
                    ))}
                  </ul>
                  <Input
                    placeholder="Batch name (e.g. Lifestyle Reset May 2026)"
                    value={batchName}
                    onChange={e => setBatchName(e.target.value)}
                  />
                  <div className="rounded-xl border border-red-200 bg-red-50 p-3">
                    <p className="text-[10px] font-bold text-red-700">Step 5 · Type to confirm</p>
                    <p className="mt-1 font-mono text-xs text-red-800 break-all">{expectedPhrase}</p>
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
              </motion.div>
            )}

            <motion.div variants={fadeUp}>
              <Card className="rounded-2xl border border-black/[0.06] p-5 space-y-3 shadow-sm">
                <h3 className="text-sm font-bold text-slate-800">Archive history</h3>
                {!batches.length ? (
                  <p className="text-xs text-slate-500">No archive batches yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {batches.map(b => (
                      <li
                        key={b.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-black/[0.06] bg-white px-4 py-3 text-[11px]"
                      >
                        <span>
                          <span className="font-bold text-slate-800">{b.name}</span>
                          <span className="mt-0.5 block text-slate-500">
                            {b.moduleKeys.join(', ')} · {b.recordCount} records · {b.status}
                          </span>
                          <span className="text-slate-400">{new Date(b.createdAt).toLocaleString()}</span>
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
            </motion.div>
          </>
        )}
      </motion.div>
    </div>
  )
}
