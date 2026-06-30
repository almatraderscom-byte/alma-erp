'use client'
import { useDeferredValue, useMemo, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import toast from 'react-hot-toast'
import { motion } from 'framer-motion'
import { Button, Card, Empty, Money, Progress, SearchInput, Select, Skeleton } from '@/components/ui'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { TradingPageShell } from '@/components/trading/TradingPageShell'
import { useTradingAccounts, useTradingStaff, useUpdateTradingAccount } from '@/hooks/useTrading'
import { useActor } from '@/contexts/ActorContext'
import type { TradingAccountListItem } from '@/types/trading'
import { money, statusClass, TRADING_STATUS_OPTIONS } from '@/components/trading/trading-utils'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25 } } }

const TradingAccountModal = dynamic(
  () => import('@/components/trading/TradingModals').then(mod => mod.TradingAccountModal),
  { ssr: false, loading: () => null },
)

export default function TradingAccountsPage() {
  const { role } = useActor()
  const isAdmin = role === 'SUPER_ADMIN' || role === 'ADMIN'
  const isSuperAdmin = role === 'SUPER_ADMIN'
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [status, setStatus] = useState('ALL')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TradingAccountListItem | null>(null)
  const { data, loading, refetch } = useTradingAccounts({ search: deferredSearch, status })
  const { data: staffData } = useTradingStaff()
  const { mutate: updateAccount, loading: archiving } = useUpdateTradingAccount()
  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts])

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(account: TradingAccountListItem) {
    setEditing(account)
    setModalOpen(true)
  }

  async function archive(account: TradingAccountListItem) {
    if (!(await confirmDialog({ message: `Archive ${account.accountTitle}?`, confirmLabel: 'Archive', danger: true }))) return
    const res = await updateAccount(account.id, { action: 'archive' })
    if (!res?.ok) { toast.error('Could not archive account'); return }
    toast.success('Trading account archived')
    refetch()
  }

  return (
    <TradingPageShell
      title="Trading Accounts"
      subtitle={`${accounts.length} account${accounts.length === 1 ? '' : 's'} · independent wallets and merchant progress`}
      actions={isAdmin ? <Button variant="gold" onClick={openCreate}>+ Create account</Button> : undefined}
    >
      <motion.div variants={stagger} initial="hidden" animate="show" className="min-w-0 max-w-full space-y-5">
      <motion.div variants={fadeUp} className="flex flex-col gap-2 sm:flex-row">
        <div className="flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search title, UID, staff..." />
        </div>
        <Select value={status} onChange={setStatus} options={TRADING_STATUS_OPTIONS.map(o => ({ label: o.label, value: o.value }))} />
      </motion.div>

      <motion.div variants={fadeUp}>
      <Card className="hidden min-w-0 rounded-2xl md:block">
        {loading ? (
          <div className="p-4"><Skeleton className="h-40" /></div>
        ) : accounts.length === 0 ? (
          <Empty icon="◧" title="No trading accounts" desc="Create the first Binance merchant account profile." />
        ) : (
          <div className="max-h-[72vh] overflow-x-auto overflow-y-auto min-w-0 max-w-full">
            <table className="w-full min-w-[980px] border-collapse text-xs">
              <thead className="sticky top-0 bg-card/85 z-10">
                <tr className="border-b border-white/[0.06]">
                  {['Account', 'Staff', 'Current balance', 'Initial capital', 'Profit', 'Expenses', 'Withdrawals', 'Goal progress', 'Status', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {accounts.map(account => (
                  <tr key={account.id} className="border-b border-white/[0.04] transition-colors hover:bg-white/[0.04]">
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/trading/accounts/${account.id}`} className="font-bold text-cream hover:text-gold">{account.accountTitle}</Link>
                        {account.partnershipEnabled && (
                          <span className="rounded-full border border-gold/20 bg-gold/8 px-2 py-0.5 text-[10px] font-bold text-gold">
                            50/50
                            {account.partnershipNetStaffOwes != null && account.partnershipNetStaffOwes !== 0 && (
                              <span className="ml-1 text-amber-600">· ৳{Math.abs(account.partnershipNetStaffOwes).toLocaleString('en-BD')}</span>
                            )}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 font-mono text-[10px] text-muted">{account.binanceUid || account.id}</p>
                    </td>
                    <td className="px-4 py-3 text-muted">{account.assignedUser?.name || 'Unassigned'}</td>
                    <td className={`px-4 py-3 font-bold ${Number(account.currentBalance) < 0 ? 'text-red-400' : 'text-gold'}`}><Money amount={Number(account.currentBalance)} /></td>
                    <td className="px-4 py-3 font-bold text-cream"><Money amount={Number(account.startingCapital)} /></td>
                    <td className="px-4 py-3 font-bold text-green-400"><Money amount={Number(account.totalProfit)} /></td>
                    <td className="px-4 py-3 font-bold text-amber-500"><Money amount={Number(account.totalExpenses)} /></td>
                    <td className="px-4 py-3 font-bold text-muted-hi"><Money amount={Number(account.totalWithdrawals)} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Progress value={Number(account.merchantProgress)} className="w-24" />
                        <span className="font-bold text-muted">{money(account.merchantProgress)}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3"><span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${statusClass(account.status)}`}>{account.status}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <Link href={`/trading/accounts/${account.id}`}><Button size="xs" variant="ghost">Open</Button></Link>
                        {isAdmin && <Button size="xs" variant="secondary" onClick={() => openEdit(account)}>Edit</Button>}
                        {isAdmin && <Button size="xs" variant="danger" disabled={archiving} onClick={() => void archive(account)}>Archive</Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      </motion.div>

      <div className="space-y-3 md:hidden">
        {loading ? <Skeleton className="h-40" /> : accounts.length === 0 ? <Card className="rounded-2xl"><Empty icon="◧" title="No trading accounts" /></Card> : accounts.map((account, i) => (
          <motion.div key={account.id} variants={fadeUp}>
          <Card className="rounded-2xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/trading/accounts/${account.id}`} className="font-bold text-cream">{account.accountTitle}</Link>
                  {account.partnershipEnabled && (
                    <span className="rounded-full border border-gold/20 bg-gold/8 px-2 py-0.5 text-[9px] font-bold text-gold">
                      50/50
                      {account.partnershipNetStaffOwes != null && account.partnershipNetStaffOwes !== 0 && (
                        <span className="ml-1">· ৳{Math.abs(account.partnershipNetStaffOwes).toLocaleString('en-BD')}</span>
                      )}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted">{account.assignedUser?.name || 'Unassigned'} · {account.binanceUid || 'No UID'}</p>
              </div>
              <span className={`rounded-full border px-2 py-1 text-[9px] font-bold ${statusClass(account.status)}`}>{account.status}</span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <MiniStat label="Balance" value={<Money amount={Number(account.currentBalance)} />} />
              <MiniStat label="Capital" value={<Money amount={Number(account.startingCapital)} />} className="text-gold" />
              <MiniStat label="Expenses" value={<Money amount={Number(account.totalExpenses)} />} className="text-amber-500" />
            </div>
            <div className="mt-3">
              <Progress value={Number(account.merchantProgress)} />
              <p className="mt-1 text-[10px] text-muted">Merchant Goal / Monthly Target progress {money(account.merchantProgress)}%</p>
            </div>
            {isAdmin && <div className="mt-3 flex gap-2"><Button size="xs" variant="secondary" onClick={() => openEdit(account)}>Edit</Button><Button size="xs" variant="danger" disabled={archiving} onClick={() => void archive(account)}>Archive</Button></div>}
          </Card>
          </motion.div>
        ))}
      </div>

      <TradingAccountModal
        open={modalOpen}
        account={editing}
        staff={staffData?.staff ?? []}
        canManageTargets={isSuperAdmin}
        onClose={() => setModalOpen(false)}
        onSaved={refetch}
      />
      </motion.div>
    </TradingPageShell>
  )
}

function MiniStat({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.04] p-2">
      <p className="text-[9px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 text-xs font-bold ${className || 'text-cream'}`}>{value}</p>
    </div>
  )
}
