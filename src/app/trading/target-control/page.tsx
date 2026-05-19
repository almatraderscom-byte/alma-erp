'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useSession } from 'next-auth/react'
import { Button, Card, Empty, Input, KpiCard, KPI_AUTO_GRID, Select, Skeleton } from '@/components/ui'
import { TradingPageShell } from '@/components/trading/TradingPageShell'
import { useTradingAccounts } from '@/hooks/useTrading'
import { api } from '@/lib/api'
import { normalizeAlmaRole } from '@/lib/roles'
import { statusClass } from '@/components/trading/trading-utils'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'

type VolumeTargetRow = {
  id: string
  accountTitle?: string
  assignedUserName?: string
  targetDate: string
  targetUsdt: number
  actualUsdt: number
  shortfallUsdt: number
  status: string
  penaltyAmountBdt: number | null
  penalty?: { status: string; finalPenaltyBdt: number } | null
}

const today = new Date().toISOString().slice(0, 10)

export default function TradingTargetControlPage() {
  const { data: session } = useSession()
  const role = normalizeAlmaRole(session?.user?.role)
  const canManage = role === 'SUPER_ADMIN'
  const readOnly = role === 'ADMIN'

  const [date, setDate] = useState(today)
  const [targets, setTargets] = useState<VolumeTargetRow[]>([])
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState({ autoPenaltyEnabled: false, defaultPenaltyBdt: 500 })
  const [analytics, setAnalytics] = useState<{ targetCount?: number; met?: number; missed?: number; ignored?: number } | null>(null)
  const [tab, setTab] = useState<'targets' | 'penalties' | 'analytics' | 'settings'>('targets')

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState({ trading_account_id: '', target_usdt: '', penalty_amount_bdt: '' })
  const [busyId, setBusyId] = useState<string | null>(null)

  const { data: accountsData } = useTradingAccounts({ status: 'ACTIVE' })
  const accountOptions = useMemo(
    () => (accountsData?.accounts || []).map(a => ({ label: a.accountTitle, value: a.id })),
    [accountsData?.accounts],
  )

  const penaltyQueue = useMemo(
    () => targets.filter(t => t.status === 'MISSED' && (!t.penalty || t.penalty.status === 'PENDING')),
    [targets],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [list, settingsRes, analyticsRes] = await Promise.all([
        api.trading.volumeTargets({ date }),
        api.trading.volumeTargetSettings(),
        api.trading.volumeTargetAnalytics({ month: date.slice(0, 7) }),
      ])
      setTargets((list.targets || []) as VolumeTargetRow[])
      setSettings(settingsRes.settings)
      setAnalytics((analyticsRes.summary || analyticsRes.analytics) as typeof analytics)
    } catch (e) {
      toast.error((e as Error).message || 'Failed to load targets')
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') return
    void load()
  }, [load, role])

  useRegisterMobileRefresh(load, role === 'SUPER_ADMIN' || role === 'ADMIN')

  if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
    return (
      <TradingPageShell title="Target Control" subtitle="Restricted">
        <Card className="p-6 text-sm text-zinc-400">You do not have access to trading volume targets.</Card>
      </TradingPageShell>
    )
  }

  async function createTarget(e: React.FormEvent) {
    e.preventDefault()
    if (!canManage) return
    try {
      await api.trading.createVolumeTarget({
        trading_account_id: createForm.trading_account_id,
        target_date: date,
        target_usdt: Number(createForm.target_usdt),
        penalty_amount_bdt: createForm.penalty_amount_bdt ? Number(createForm.penalty_amount_bdt) : undefined,
      })
      toast.success('Daily target created')
      setCreateOpen(false)
      setCreateForm({ trading_account_id: '', target_usdt: '', penalty_amount_bdt: '' })
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function runAction(id: string, action: string, extra?: Record<string, unknown>) {
    if (!canManage) return
    setBusyId(id)
    try {
      await api.trading.volumeTargetAction(id, { action, ...extra })
      toast.success('Updated')
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function saveSettings() {
    if (!canManage) return
    try {
      await api.trading.updateVolumeTargetSettings({
        auto_penalty_enabled: settings.autoPenaltyEnabled,
        default_penalty_bdt: settings.defaultPenaltyBdt,
      })
      toast.success('Auto-penalty settings saved')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <TradingPageShell
      title="Target Control"
      subtitle={canManage ? 'Super Admin · daily USDT targets & penalties' : readOnly ? 'Read-only · volume target monitoring' : ''}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="max-w-[160px]" />
          {canManage && (
            <Button variant="gold" onClick={() => setCreateOpen(true)}>+ Set target</Button>
          )}
          <Button variant="secondary" onClick={() => void load()}>Refresh</Button>
        </div>
      }
    >
      <div className="flex flex-wrap gap-2">
        {(['targets', 'penalties', 'analytics', 'settings'] as const).map(t => (
          <Button key={t} size="sm" variant={tab === t ? 'gold' : 'ghost'} onClick={() => setTab(t)}>
            {t === 'targets' ? 'Accounts' : t === 'penalties' ? `Penalty queue (${penaltyQueue.length})` : t.charAt(0).toUpperCase() + t.slice(1)}
          </Button>
        ))}
      </div>

      {analytics && (
        <div className={KPI_AUTO_GRID}>
          <KpiCard label="Targets" value={String(analytics.targetCount ?? 0)} />
          <KpiCard label="Met" value={String(analytics.met ?? 0)} color="green" />
          <KpiCard label="Missed" value={String(analytics.missed ?? 0)} color="red" />
          <KpiCard label="Ignored" value={String(analytics.ignored ?? 0)} />
        </div>
      )}

      {tab === 'settings' && (
        <Card className="space-y-4 p-4">
          <p className="text-sm font-bold text-cream">Auto-penalty configuration</p>
          {canManage ? (
            <>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={settings.autoPenaltyEnabled}
                  onChange={e => setSettings(s => ({ ...s, autoPenaltyEnabled: e.target.checked }))}
                />
                Enable automatic penalty application on missed targets
              </label>
              <Input
                type="number"
                min="0"
                value={settings.defaultPenaltyBdt}
                onChange={e => setSettings(s => ({ ...s, defaultPenaltyBdt: Number(e.target.value) }))}
                placeholder="Default penalty BDT"
              />
              <Button variant="gold" onClick={() => void saveSettings()}>Save settings</Button>
            </>
          ) : (
            <p className="text-sm text-zinc-500">
              Auto-penalty: {settings.autoPenaltyEnabled ? 'On' : 'Off'} · Default ৳{settings.defaultPenaltyBdt}
            </p>
          )}
        </Card>
      )}

      {tab === 'analytics' && (
        <Card className="p-4 text-sm text-zinc-400">
          {canManage
            ? 'Use Accounts and Penalty queue for enforcement. Month KPIs are shown above.'
            : 'Summary KPIs above reflect the selected month. Contact Super Admin for penalty actions.'}
        </Card>
      )}

      {(tab === 'targets' || tab === 'penalties') && (
        loading ? (
          <Skeleton className="h-48 w-full" />
        ) : (tab === 'penalties' ? penaltyQueue : targets).length === 0 ? (
          <Empty icon="◎" title="No targets" desc={tab === 'penalties' ? 'No missed targets awaiting penalty.' : 'Set a daily USDT target per account.'} />
        ) : (
          <div className="space-y-3">
            {(tab === 'penalties' ? penaltyQueue : targets).map(row => (
              <Card key={row.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-bold text-cream">{row.accountTitle}</p>
                    <p className="text-xs text-zinc-500">{row.assignedUserName || 'Unassigned'} · {row.targetDate.slice(0, 10)}</p>
                    <p className="mt-2 text-sm text-zinc-300">
                      Target {row.targetUsdt} USDT · Actual {row.actualUsdt} USDT
                      {row.shortfallUsdt > 0 ? ` · Short ${row.shortfallUsdt}` : ''}
                    </p>
                    <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </div>
                  {canManage && (
                    <div className="flex flex-wrap gap-2">
                      <Button size="xs" variant="secondary" disabled={busyId === row.id} onClick={() => void runAction(row.id, 'REFRESH')}>
                        Recalc
                      </Button>
                      {row.status === 'MISSED' && !row.penalty && (
                        <Button size="xs" variant="danger" disabled={busyId === row.id} onClick={() => void runAction(row.id, 'APPLY_PENALTY', { amount_bdt: row.penaltyAmountBdt ?? settings.defaultPenaltyBdt })}>
                          Apply penalty
                        </Button>
                      )}
                      {row.penalty && ['APPLIED', 'PARTIALLY_WAIVED'].includes(row.penalty.status) && (
                        <Button size="xs" variant="ghost" disabled={busyId === row.id} onClick={() => void runAction(row.id, 'WAIVE_PENALTY', { waive_amount_bdt: row.penalty?.finalPenaltyBdt })}>
                          Waive
                        </Button>
                      )}
                      {row.status === 'MISSED' && (
                        <Button size="xs" variant="ghost" disabled={busyId === row.id} onClick={() => void runAction(row.id, 'IGNORE')}>
                          Ignore failure
                        </Button>
                      )}
                      <Button size="xs" variant="ghost" disabled={busyId === row.id} onClick={async () => {
                        if (!confirm('Delete this target?')) return
                        try {
                          await api.trading.deleteVolumeTarget(row.id)
                          toast.success('Removed')
                          await load()
                        } catch (err) {
                          toast.error((err as Error).message)
                        }
                      }}>
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )
      )}

      {createOpen && canManage && (
        <Card className="fixed inset-x-3 bottom-20 z-50 mx-auto max-w-lg border-gold-dim/40 p-4 shadow-2xl sm:bottom-auto sm:top-24">
          <p className="mb-3 text-sm font-bold text-cream">Create daily target</p>
          <form className="space-y-3" onSubmit={e => void createTarget(e)}>
            <Select
              value={createForm.trading_account_id}
              onChange={v => setCreateForm(f => ({ ...f, trading_account_id: v }))}
              options={[{ label: 'Select account', value: '' }, ...accountOptions]}
            />
            <Input type="number" min="0" step="0.01" placeholder="Target USDT" value={createForm.target_usdt} onChange={e => setCreateForm(f => ({ ...f, target_usdt: e.target.value }))} />
            <Input type="number" min="0" step="1" placeholder="Penalty BDT (optional)" value={createForm.penalty_amount_bdt} onChange={e => setCreateForm(f => ({ ...f, penalty_amount_bdt: e.target.value }))} />
            <div className="flex gap-2">
              <Button type="submit" variant="gold">Save</Button>
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}
    </TradingPageShell>
  )
}