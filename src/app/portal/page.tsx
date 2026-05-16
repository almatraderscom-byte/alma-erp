'use client'

import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { Button, Card, Empty, Input, Skeleton } from '@/components/ui'
import { useBusiness } from '@/contexts/BusinessContext'
import { normalizeAlmaRole } from '@/lib/roles'
import type { EmployeeWalletResponse, WalletRequestDto } from '@/types/payroll-wallet'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

type MeUser = {
  id: string
  email: string
  name: string
  phone: string | null
  role: string
  businessAccess: string
  employeeIdGas: string | null
  joiningDate: string | null
  salaryHint: string | null
  profileImageUrl: string | null
}

export default function EmployeePortalPage() {
  const { data: session } = useSession()
  const { business } = useBusiness()
  const role = normalizeAlmaRole(session?.user?.role)

  const [me, setMe] = useState<MeUser | null>(null)
  const [loadingMe, setLoadingMe] = useState(true)
  const [wallet, setWallet] = useState<EmployeeWalletResponse | null>(null)
  const [walletLoading, setWalletLoading] = useState(true)

  const empId = session?.user?.employeeIdGas?.trim() || null

  const loadMe = useCallback(async () => {
    setLoadingMe(true)
    try {
      const res = await fetch('/api/users/me', { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || res.statusText)
      setMe(j.user as MeUser)
    } catch {
      setMe(null)
    } finally {
      setLoadingMe(false)
    }
  }, [])

  useEffect(() => {
    void loadMe()
  }, [loadMe])

  const loadWallet = useCallback(async () => {
    if (!empId) {
      setWallet(null)
      setWalletLoading(false)
      return
    }
    setWalletLoading(true)
    try {
      const res = await fetch(`/api/payroll/wallet/${encodeURIComponent(empId)}?business_id=${business.id}`, { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || res.statusText)
      setWallet(j as EmployeeWalletResponse)
    } catch (e) {
      toast.error((e as Error).message || 'Could not load wallet')
      setWallet(null)
    } finally {
      setWalletLoading(false)
    }
  }, [business.id, empId])

  useEffect(() => {
    void loadWallet()
  }, [loadWallet])

  const ordersHref = business.id === 'CREATIVE_DIGITAL_IT' ? '/digital/projects' : '/orders/new'

  return (
    <FinancePageChrome
      title="My desk"
      subtitle="Wallet balance · withdrawal requests · payroll history"
      actions={(
        <div className="flex gap-2 flex-wrap justify-end">
          <Link href={ordersHref}>
            <Button size="xs" variant="gold">{business.id === 'CREATIVE_DIGITAL_IT' ? 'Projects' : 'New order'}</Button>
          </Link>
          <Link href="/invoice"><Button size="xs" variant="secondary">Invoices</Button></Link>
        </div>
      )}
    >
      <div className="grid md:grid-cols-2 gap-4">
        <Card className="p-5 space-y-3 border-gold-dim/25 bg-[#0c0c10]">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Profile</p>
          {loadingMe ? <Skeleton className="h-28 w-full" /> : !me ? (
            <Empty icon="◇" title="Could not load profile" desc="Try refreshing — auth database may be offline." />
          ) : (
            <dl className="grid gap-2 text-[11px]">
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Name</dt><dd className="text-cream font-medium">{me.name}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Email</dt><dd className="font-mono text-zinc-400 truncate max-w-[55%]" title={me.email}>{me.email}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Role</dt><dd className="text-gold-lt">{role.replace(/_/g, ' ')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Business scope</dt><dd className="text-zinc-400 text-right">{me.businessAccess.replace(/,/g, ', ')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">HR employee ID</dt><dd className="font-mono text-zinc-400">{me.employeeIdGas || '— link in Users'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Salary hint</dt><dd className="font-mono text-gold">
                {me.salaryHint != null ? `৳ ${Number(me.salaryHint).toLocaleString('en-BD')}` : '—'}
              </dd></div>
            </dl>
          )}
        </Card>

        <WalletOverviewCard loading={walletLoading} wallet={wallet} />

        <WalletRequestCard
          businessId={business.id}
          empLinked={Boolean(empId)}
          onSubmitted={() => {
            void loadWallet()
            void loadMe()
          }}
        />

        <Card className="p-5 md:col-span-2">
          <p className="text-sm font-bold text-cream mb-3">Wallet transaction history</p>
          {!empId ? (
            <p className="text-[11px] text-zinc-500">Link your HR employee ID (Users settings) to activate the payroll wallet.</p>
          ) : walletLoading ? (
            <Skeleton className="h-36 w-full" />
          ) : !(wallet?.entries ?? []).length ? (
            <p className="text-[11px] text-zinc-500">No wallet entries yet. HR can run monthly salary accruals from Payroll.</p>
          ) : (
            <div className="divide-y divide-border max-h-56 overflow-y-auto text-[11px]">
              {(wallet!.entries ?? []).slice().reverse().slice(0, 60).map(tx => (
                <div key={String(tx.id ?? `${tx.date}-${tx.type}`)} className="py-2 grid grid-cols-[82px_1fr_auto_auto] gap-2 items-center">
                  <span className="text-zinc-500 font-mono">{String(tx.date).slice(0, 10)}</span>
                  <span className="text-cream">{tx.type.replace(/_/g, ' ')}</span>
                  <span className={tx.signedAmount >= 0 ? 'font-mono text-green-400' : 'font-mono text-red-400'}>
                    {tx.signedAmount >= 0 ? '+' : '-'}৳ {Math.abs(tx.signedAmount).toLocaleString('en-BD')}
                  </span>
                  <span className="font-mono text-gold-lt">৳ {tx.runningBalance.toLocaleString('en-BD')}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5 md:col-span-2 bg-black/25 border-border">
          <p className="text-sm font-bold text-cream mb-2">Pending requests</p>
          <RequestList requests={wallet?.requests ?? []} />
        </Card>
      </div>
    </FinancePageChrome>
  )
}

function money(n: unknown) {
  return `৳ ${Number(n || 0).toLocaleString('en-BD')}`
}

function WalletOverviewCard({ loading, wallet }: { loading: boolean; wallet: EmployeeWalletResponse | null }) {
  const s = wallet?.summary
  return (
    <Card className="p-5 border-gold-dim/25 bg-[#0c0c10]">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold mb-4">Employee wallet</p>
      {loading ? <Skeleton className="h-40 w-full" /> : !s ? (
        <Empty icon="◇" title="Wallet not active" desc="Link your HR employee ID to view salary balance." />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <WalletStat label="Current balance" value={money(s.currentBalance)} tone="text-green-400" />
          <WalletStat label="Withdrawable" value={money(s.availableWithdrawable)} tone="text-gold-lt" />
          <WalletStat label="Salary earned" value={money(s.totalAccrued)} />
          <WalletStat label="Commission" value={money(s.totalCommissions)} tone="text-green-400" />
          <WalletStat label="Eid bonus" value={money(s.totalEidBonuses)} />
          <WalletStat label="Overtime" value={money(s.totalOvertime)} />
          <WalletStat label="Penalties" value={money(s.totalPenalties)} tone="text-red-400" />
          <WalletStat label="Meal deductions" value={money(s.totalMealDeductions)} tone="text-red-400" />
          <WalletStat label="Advances" value={money(s.totalAdvances)} tone="text-amber-300" />
          <WalletStat label="Withdrawals" value={money(s.totalWithdrawals)} tone="text-zinc-300" />
        </div>
      )}
    </Card>
  )
}

function WalletStat({ label, value, tone = 'text-cream' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-black/25 p-3">
      <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-600">{label}</p>
      <p className={`mt-1 font-mono text-sm font-bold ${tone}`}>{value}</p>
    </div>
  )
}

function WalletRequestCard({
  businessId,
  empLinked,
  onSubmitted,
}: {
  businessId: string
  empLinked: boolean
  onSubmitted: () => void
}) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [type, setType] = useState<'WITHDRAWAL' | 'ADVANCE'>('WITHDRAWAL')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const amt = Number(amount)
    const r = reason.trim()
    if (!amt || amt <= 0 || !r) {
      toast.error('Amount and reason required')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/wallet/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, amount: amt, reason: r, business_id: businessId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(j.error || 'Request failed')
        return
      }
      toast.success(`${type === 'WITHDRAWAL' ? 'Withdrawal' : 'Advance'} requested — awaiting approval`)
      setAmount('')
      setReason('')
      onSubmitted()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-5 space-y-4 border-gold-dim/20">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Wallet requests</p>
      <form onSubmit={submit} className="space-y-3 text-[11px]">
        <div className="grid grid-cols-2 gap-2">
          {(['WITHDRAWAL', 'ADVANCE'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${type === t ? 'border-gold-dim/50 bg-gold/15 text-gold-lt' : 'border-border bg-card text-zinc-400 hover:text-cream'}`}
            >
              {t === 'WITHDRAWAL' ? 'Request withdrawal' : 'Request advance'}
            </button>
          ))}
        </div>
        <label className="block space-y-1">
          <span className="text-zinc-500">Amount (৳)</span>
          <Input value={amount} onChange={e => setAmount(e.target.value)} type="number" min={1} step="1" className="font-mono" disabled={!empLinked} />
        </label>
        <label className="block space-y-1">
          <span className="text-zinc-500">Reason</span>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} disabled={!empLinked} className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm resize-none disabled:opacity-40" />
        </label>
        <Button variant="gold" type="submit" className="w-full justify-center" disabled={busy || !empLinked}>{busy ? 'Sending…' : 'Submit request'}</Button>
      </form>
      {!empLinked && <p className="text-[11px] text-amber-400">Ask an admin to link your HR employee ID before requesting wallet movements.</p>}
    </Card>
  )
}

function RequestList({ requests }: { requests: WalletRequestDto[] }) {
  if (!requests.length) return <p className="text-[11px] text-zinc-600">No wallet requests yet.</p>
  return (
    <ul className="space-y-1.5 max-h-44 overflow-y-auto text-[11px]">
      {requests.slice(0, 20).map(r => (
        <li key={r.id} className="flex justify-between gap-2 border-b border-border/50 pb-1.5">
          <span className="text-zinc-500 font-mono">{r.createdAt.slice(0, 10)}</span>
          <span className="text-cream flex-1">{r.type.replace(/_/g, ' ')} · {money(r.requestedAmount)}</span>
          <span className={r.status === 'PENDING' ? 'text-amber-400' : r.status.includes('APPROVED') ? 'text-green-400' : 'text-red-400'}>{r.status.replace(/_/g, ' ')}</span>
        </li>
      ))}
    </ul>
  )
}
