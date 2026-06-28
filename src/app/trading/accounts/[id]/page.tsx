'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import toast from 'react-hot-toast'
import { motion } from 'framer-motion'
import { Button, Card, Empty, Input, KpiCard, KPI_AUTO_GRID, Money, Progress, Select, Skeleton, Spinner, StatRow } from '@/components/ui'
import { TradingPageShell } from '@/components/trading/TradingPageShell'
import { useAddTradingBkashSummary, useSettleTradingPartnership, useTradingAccountDetail, useTradingPartnership, useTradingStaff, useUpdateTradingTrade, useUploadTradingPerformanceScreenshot } from '@/hooks/useTrading'
import { useActor } from '@/contexts/ActorContext'
import type { TradingAccount, TradingBkashDailySummary, TradingCapitalEntry, TradingDailySummary, TradingExpense, TradingMutationResponse, TradingPartnershipSettlement, TradingPerformanceScreenshot, TradingSummary, TradingTrade, TradingTradeActionInput } from '@/types/trading'
import { money, signedClass, statusClass } from '@/components/trading/trading-utils'
import { optimizeTradingScreenshot } from '@/lib/trading-screenshot'
import { invalidateQueryCache } from '@/hooks/useQuery'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25 } } }

const TradeEntryModal = dynamic(
  () => import('@/components/trading/TradingModals').then(mod => mod.TradeEntryModal),
  { ssr: false, loading: () => null },
)
const ExpenseEntryModal = dynamic(
  () => import('@/components/trading/TradingModals').then(mod => mod.ExpenseEntryModal),
  { ssr: false, loading: () => null },
)
const CapitalEntryModal = dynamic(
  () => import('@/components/trading/TradingModals').then(mod => mod.CapitalEntryModal),
  { ssr: false, loading: () => null },
)
const TradingAccountModal = dynamic(
  () => import('@/components/trading/TradingModals').then(mod => mod.TradingAccountModal),
  { ssr: false, loading: () => null },
)
const ScreenshotUploadModal = dynamic(
  () => import('@/components/trading/ScreenshotUploadModal').then(mod => mod.ScreenshotUploadModal),
  { ssr: false, loading: () => null },
)

type Tab = 'TRADES' | 'EXPENSES' | 'DAILY_SUMMARY' | 'PERFORMANCE' | 'STAFF' | 'SETTLEMENT'
type TradeActionMode = 'edit' | 'request_delete' | 'approve_delete' | 'reject_delete' | 'audit'

export default function TradingAccountDetailPage() {
  const params = useParams<{ id: string }>()
  const searchParams = useSearchParams()
  const accountId = String(params?.id || '')
  const { role } = useActor()
  const isAdmin = role === 'SUPER_ADMIN' || role === 'ADMIN'
  const isSuperAdmin = role === 'SUPER_ADMIN'
  const { data, loading, refetch } = useTradingAccountDetail(accountId)
  const { data: staffData } = useTradingStaff()
  const initialTab = (searchParams.get('tab')?.toUpperCase() || 'TRADES') as Tab
  const [tab, setTab] = useState<Tab>(['TRADES', 'EXPENSES', 'DAILY_SUMMARY', 'PERFORMANCE', 'STAFF', 'SETTLEMENT'].includes(initialTab) ? initialTab : 'TRADES')
  const [tradeOpen, setTradeOpen] = useState(searchParams.get('action') === 'trade')
  const [screenshotOpen, setScreenshotOpen] = useState(searchParams.get('action') === 'screenshot' || searchParams.get('upload') === '1')
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [capitalOpen, setCapitalOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [optimisticSummary, setOptimisticSummary] = useState<TradingSummary | null>(null)
  const [optimisticTrades, setOptimisticTrades] = useState<TradingTrade[]>([])
  const [optimisticExpenses, setOptimisticExpenses] = useState<TradingExpense[]>([])
  const [optimisticCapital, setOptimisticCapital] = useState<TradingCapitalEntry[]>([])
  const [optimisticBkashSummaries, setOptimisticBkashSummaries] = useState<TradingBkashDailySummary[]>([])
  const [optimisticScreenshots, setOptimisticScreenshots] = useState<TradingPerformanceScreenshot[]>([])
  const [optimisticToday, setOptimisticToday] = useState<TradingDailySummary | null>(null)
  const [tradeAction, setTradeAction] = useState<{ mode: TradeActionMode; trade: TradingTrade } | null>(null)

  const account = data?.account ?? null
  const summary = optimisticSummary ?? data?.summary
  const today = optimisticToday ?? data?.today
  const trades = useMemo(() => dedupeTrades([...optimisticTrades, ...(data?.recentTrades ?? [])]).slice(0, 30), [data?.recentTrades, optimisticTrades])
  const expenses = useMemo(() => [...optimisticExpenses, ...(data?.recentExpenses ?? [])].slice(0, 30), [data?.recentExpenses, optimisticExpenses])
  const capitalEntries = useMemo(() => [...optimisticCapital, ...(data?.recentCapitalEntries ?? [])].slice(0, 30), [data?.recentCapitalEntries, optimisticCapital])
  const bkashSummaries = useMemo(() => [...optimisticBkashSummaries, ...(data?.bkashSummaries ?? [])].slice(0, 30), [data?.bkashSummaries, optimisticBkashSummaries])
  const performanceScreenshots = useMemo(() => [...optimisticScreenshots, ...(data?.performanceScreenshots ?? [])].slice(0, 7), [data?.performanceScreenshots, optimisticScreenshots])
  const partnershipEnabled = Boolean(account?.partnershipEnabled)
  const visibleTabs = useMemo(() => {
    const base: Tab[] = ['TRADES', 'EXPENSES', 'DAILY_SUMMARY', 'PERFORMANCE', 'STAFF']
    if (partnershipEnabled) base.push('SETTLEMENT')
    return base
  }, [partnershipEnabled])

  function onMutation(res: TradingMutationResponse) {
    setOptimisticSummary(res.summary)
    if (res.trade) setOptimisticTrades(rows => [res.trade!, ...rows])
    if (res.expense) setOptimisticExpenses(rows => [res.expense!, ...rows])
    if (res.capitalEntry) setOptimisticCapital(rows => [res.capitalEntry!, ...rows])
    if (res.bkashSummary) setOptimisticBkashSummaries(rows => [res.bkashSummary!, ...rows])
    if (res.trade) setOptimisticToday(current => nextTodayAfterTrade(current ?? data?.today ?? emptyTradingDay(), res.trade!))
    if (res.bkashSummary) setOptimisticToday(current => nextTodayAfterBkash(current ?? data?.today ?? emptyTradingDay(), res.bkashSummary!))
    invalidateQueryCache('trading-summary:')
    invalidateQueryCache('trading-dashboard:')
    invalidateQueryCache('trading-account:')
    invalidateQueryCache('trading-analytics:')
    refetch()
  }

  function onTradeAction(res: { trade: TradingTrade; summary?: TradingSummary }) {
    if (res.summary) setOptimisticSummary(res.summary)
    setOptimisticTrades(rows => mergeTradeRows(rows, res.trade))
    invalidateQueryCache('trading-summary:')
    invalidateQueryCache('trading-dashboard:')
    invalidateQueryCache('trading-account:')
    invalidateQueryCache('trading-analytics:')
    refetch()
  }

  return (
    <TradingPageShell
      title={account?.accountTitle || 'Trading Account'}
      subtitle={account ? `${account.binanceUid || 'No UID'} · ${account.assignedUser?.name || 'Unassigned staff'}` : 'Account details'}
      actions={
        <>
          <Link href="/trading/accounts"><Button variant="ghost">Accounts</Button></Link>
          {isAdmin && <Button variant="secondary" onClick={() => setEditOpen(true)}>Edit</Button>}
          <Button variant="secondary" onClick={() => setScreenshotOpen(true)} disabled={!account}>Screenshot</Button>
          <Button variant="gold" onClick={() => setTradeOpen(true)} disabled={!account}>+ Trade</Button>
        </>
      }
    >
      {loading && !data ? (
        <Skeleton className="h-80" />
      ) : !account || !summary ? (
        <Card className="rounded-2xl"><Empty icon="◇" title="Trading account not found" /></Card>
      ) : (
        <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-5">
          <motion.div variants={fadeUp} className={KPI_AUTO_GRID}>
            <KpiCard label="Current balance" value={summary.currentBalance} valueKind="currency" color={summary.currentBalance < 0 ? 'text-red-400' : 'text-gold'} />
            <KpiCard label="Initial capital" value={summary.startingCapital} valueKind="currency" color="text-gold" />
            <KpiCard label="Total trades" value={summary.totalTrades} valueKind="number" />
            <KpiCard label="USDT balance" value={summary.usdtBalance} valueKind="usdt" />
            <KpiCard label="Total profit" value={summary.totalProfit} valueKind="currency" color="text-green-400" />
            <KpiCard label="Total loss" value={summary.totalLoss} valueKind="currency" color="text-red-400" />
            <KpiCard label="Expenses" value={summary.totalExpenses} valueKind="currency" color="text-amber-500" />
            <KpiCard label="Withdrawals" value={summary.totalWithdrawals} valueKind="currency" color="text-muted-hi" />
          </motion.div>
          <motion.div variants={fadeUp} className={KPI_AUTO_GRID}>
            <KpiCard label="USDT volume" value={summary.totalTradedUsdt} valueKind="usdt" />
            <KpiCard label="Buy volume" value={summary.totalBuyUsdt} valueKind="usdt" sub="USDT" />
            <KpiCard label="Sell volume" value={summary.totalSellUsdt} valueKind="usdt" sub="USDT" />
            <KpiCard label="Fee totals" value={summary.totalFees} valueKind="currency" color="text-amber-500" />
            <KpiCard label="ROI" value={`${summary.roiPct.toFixed(2)}%`} />
            <KpiCard label="Net P/L" value={summary.netOperationalProfit} valueKind="currency" color={signedClass(summary.netOperationalProfit)} />
          </motion.div>

          {summary.currentBalance < 0 && (
            <motion.div variants={fadeUp}>
            <Card className="rounded-2xl border tone-red p-4">
              <p className="text-sm font-bold">Risk warning: account balance is negative.</p>
              <p className="mt-1 text-[11px] opacity-80">Super Admin notification is created when the balance crosses below zero.</p>
            </Card>
            </motion.div>
          )}

          <motion.div variants={fadeUp} className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1.4fr]">
            <Card className="rounded-2xl p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-cream">{account.accountTitle}</p>
                  <p className="mt-1 text-[11px] text-muted">{account.accountType} · started {account.startDate.slice(0, 10)}</p>
                </div>
                <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${statusClass(account.status)}`}>{account.status}</span>
              </div>
              <div className="mt-5 space-y-1">
                <StatRow label="Assigned staff" value={account.assignedUser?.name || 'Unassigned'} />
                <StatRow label="Staff employee ID" value={account.assignedUser?.employeeIdGas || 'Not linked'} />
                <StatRow label="Staff salary hint" value={<Money amount={Number(account.assignedUser?.salaryHint || 0)} />} />
                <StatRow label="Commission type" value={account.commissionType.replace('_', ' ')} />
                <StatRow label="Commission value" value={account.commissionType === 'PERCENTAGE' ? `${Number(account.commissionRate).toFixed(2)}% of profit` : <Money amount={Number(account.fixedCommission)} />} />
                <StatRow label="Initial Capital" value={<Money amount={Number(account.startingCapital)} />} />
                <StatRow label="Deposits" value={<Money amount={summary.deposits} />} />
                <StatRow label="Total Withdrawals" value={<Money amount={summary.totalWithdrawals} />} />
                <StatRow label="Adjustments" value={<Money amount={summary.adjustments} />} />
                <StatRow label="Net ROI" value={`${summary.roiPct.toFixed(2)}%`} valueClass={signedClass(summary.roiPct)} />
              </div>
              {role === 'SUPER_ADMIN' && data?.balanceDebug && (
                <div className="mt-5 rounded-2xl border tone-blue p-3 text-xs">
                  <p className="font-bold">Balance debug</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <span className="text-muted">Calculated: ৳{data.balanceDebug.rawCalculatedBalance.toLocaleString('en-BD')}</span>
                    <span className="text-muted">Ledger total: ৳{data.balanceDebug.ledgerTotal.toLocaleString('en-BD')}</span>
                    <span className="text-muted">Expenses: ৳{data.balanceDebug.expenseTotal.toLocaleString('en-BD')}</span>
                    <span className="text-muted">Adjustments: ৳{data.balanceDebug.pendingAdjustments.toLocaleString('en-BD')}</span>
                    <span className="text-muted sm:col-span-2">Last recalculated: {new Date(data.balanceDebug.lastRecalculatedAt).toLocaleString()}</span>
                  </div>
                </div>
              )}
              <div className="mt-5">
                <div className="mb-2 flex justify-between text-[11px]">
                  <span className="text-muted">Merchant Goal / Monthly Target progress</span>
                  <span className="font-bold text-gold">{money(summary.merchantProgress)}%</span>
                </div>
                <Progress value={summary.merchantProgress} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Button variant="gold" onClick={() => setTradeOpen(true)}>Add Trade</Button>
                <Button variant="secondary" onClick={() => setScreenshotOpen(true)}>Screenshot</Button>
                <Button variant="secondary" onClick={() => setTab('DAILY_SUMMARY')}>Daily Summary</Button>
                <Button variant="secondary" onClick={() => setExpenseOpen(true)}>Expense</Button>
                {isAdmin && <Button variant="ghost" onClick={() => setCapitalOpen(true)}>Capital</Button>}
              </div>
            </Card>

            <Card className="rounded-2xl p-5">
              <p className="text-sm font-bold text-cream">Today Summary</p>
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
                <TodayCell label="Trades / Bkash orders" value={today?.tradesCount ?? 0} />
                <TodayCell label="Bkash orders" value={(today?.bkashOrders ?? 0).toLocaleString('en-BD')} />
                <TodayCell label="Buy USDT" value={(today?.buyUsdtVolume ?? 0).toLocaleString('en-BD')} />
                <TodayCell label="Sell USDT" value={(today?.sellUsdtVolume ?? 0).toLocaleString('en-BD')} />
                <TodayCell label="Profit" value={<Money amount={today?.profit ?? 0} />} className="text-green-400" />
                <TodayCell label="Loss" value={<Money amount={today?.loss ?? 0} />} className="text-red-400" />
                <TodayCell label="Fees" value={<Money amount={today?.fees ?? 0} />} className="text-amber-500" />
                <TodayCell label="Expenses" value={<Money amount={today?.expenses ?? 0} />} className="text-red-400" />
                <TodayCell label="Net result" value={<Money amount={today?.netResult ?? 0} />} className={signedClass(today?.netResult ?? 0)} />
              </div>
            </Card>
          </motion.div>

          {data?.ranges && (
            <motion.div variants={fadeUp} className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {Object.entries(data.ranges).map(([label, range]) => (
                <Card key={label} className="rounded-2xl p-4">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted">{label === 'last7' ? 'Last 7 days' : label}</p>
                  <p className={`mt-2 text-lg font-bold ${signedClass(range.netResult)}`}>৳{range.netResult.toLocaleString('en-BD')}</p>
                  <p className="mt-1 text-[11px] text-muted">{range.tradesCount} trades · {range.usdtVolume.toLocaleString('en-BD')} USDT</p>
                </Card>
              ))}
            </motion.div>
          )}

          <motion.div variants={fadeUp}>
          <Card className="overflow-hidden rounded-2xl">
            <div className="flex gap-1 overflow-x-auto border-b border-white/[0.06] p-2">
              {visibleTabs.map(t => (
                <button key={t} onClick={() => setTab(t)} className={`rounded-xl px-3 py-2 text-xs font-bold transition-colors ${tab === t ? 'bg-gold/10 text-gold' : 'text-muted hover:bg-white/[0.04]'}`}>{t === 'SETTLEMENT' ? 'SETTLEMENT' : t.replace('_', ' ')}</button>
              ))}
            </div>
            {tab === 'TRADES' && <TradeList rows={trades} isSuperAdmin={role === 'SUPER_ADMIN'} onAction={(mode, trade) => setTradeAction({ mode, trade })} />}
            {tab === 'EXPENSES' && <ExpenseList rows={expenses} showPaidBy={partnershipEnabled} />}
            {tab === 'SETTLEMENT' && partnershipEnabled && account && (
              <PartnershipSettlementPanel accountId={account.id} isAdmin={isAdmin} onSettled={refetch} />
            )}
            {tab === 'DAILY_SUMMARY' && <DailySummaryPanel accountId={account.id} rows={bkashSummaries} onCreated={onMutation} />}
            {tab === 'PERFORMANCE' && <PerformancePanel accountId={account.id} rows={performanceScreenshots} onUploaded={shot => { setOptimisticScreenshots(rows => [shot, ...rows].slice(0, 7)); refetch() }} />}
            {tab === 'STAFF' && <StaffPanel account={account} summary={summary} capitalEntries={capitalEntries} timeline={data?.timeline ?? []} />}
          </Card>
          </motion.div>

          <TradeEntryModal open={tradeOpen} account={account} onClose={() => setTradeOpen(false)} onCreated={onMutation} />
          <ExpenseEntryModal open={expenseOpen} account={account} onClose={() => setExpenseOpen(false)} onCreated={onMutation} />
          <CapitalEntryModal open={capitalOpen} account={account} onClose={() => setCapitalOpen(false)} onCreated={onMutation} />
          <TradingAccountModal open={editOpen} account={account} staff={staffData?.staff ?? []} canManageTargets={isSuperAdmin} onClose={() => setEditOpen(false)} onSaved={refetch} />
          <TradeActionModal action={tradeAction} onClose={() => setTradeAction(null)} onSaved={onTradeAction} />
          {account && (
            <ScreenshotUploadModal
              open={screenshotOpen}
              accounts={[account]}
              defaultAccountId={account.id}
              recentByAccount={{ [account.id]: performanceScreenshots }}
              onClose={() => setScreenshotOpen(false)}
              onUploaded={() => { setScreenshotOpen(false); refetch() }}
            />
          )}
        </motion.div>
      )}
    </TradingPageShell>
  )
}

function emptyTradingDay(): TradingDailySummary {
  return { tradesCount: 0, bkashOrders: 0, usdtVolume: 0, buyUsdtVolume: 0, sellUsdtVolume: 0, buyBdtVolume: 0, sellBdtVolume: 0, profit: 0, loss: 0, bkashProfit: 0, bkashLoss: 0, fees: 0, expenses: 0, netResult: 0 }
}

function nextTodayAfterTrade(today: TradingDailySummary, trade: TradingTrade): TradingDailySummary {
  const usdt = Number(trade.usdtAmount || 0)
  const netProfit = Number(trade.netProfit || 0)
  const fee = Number(trade.feeBdt || trade.feeAmount || 0)
  const buyBdt = Number(trade.buyAmount || 0)
  const sellBdt = Number(trade.sellAmount || trade.netBdt || 0)
  const profit = netProfit > 0 ? netProfit : 0
  const loss = netProfit < 0 ? Math.abs(netProfit) : 0
  return { ...today, tradesCount: today.tradesCount + 1, usdtVolume: today.usdtVolume + usdt, buyUsdtVolume: today.buyUsdtVolume + (trade.tradeType === 'BUY' ? usdt : 0), sellUsdtVolume: today.sellUsdtVolume + (trade.tradeType === 'SELL' ? usdt : 0), buyBdtVolume: today.buyBdtVolume + (trade.tradeType === 'BUY' ? buyBdt : 0), sellBdtVolume: today.sellBdtVolume + (trade.tradeType === 'SELL' ? sellBdt : 0), profit: today.profit + profit, loss: today.loss + loss, fees: today.fees + fee, netResult: today.netResult + profit - loss }
}

function nextTodayAfterBkash(today: TradingDailySummary, row: TradingBkashDailySummary): TradingDailySummary {
  const orders = Number(row.totalOrders || 0)
  const profit = Number(row.totalProfitBdt || 0)
  const loss = Number(row.totalLossBdt || 0)
  return { ...today, tradesCount: today.tradesCount + orders, bkashOrders: today.bkashOrders + orders, profit: today.profit + profit, loss: today.loss + loss, bkashProfit: today.bkashProfit + profit, bkashLoss: today.bkashLoss + loss, netResult: today.netResult + profit - loss }
}

function mergeTradeRows(rows: TradingTrade[], trade: TradingTrade) {
  const found = rows.some(row => row.id === trade.id)
  const next = found ? rows.map(row => row.id === trade.id ? trade : row) : [trade, ...rows]
  return next.slice(0, 30)
}

function dedupeTrades(rows: TradingTrade[]) {
  const seen = new Set<string>()
  return rows.filter(row => { if (seen.has(row.id)) return false; seen.add(row.id); return true })
}

function tradeStatus(trade: TradingTrade): 'ACTIVE' | 'EDITED' | 'DELETE_PENDING' | 'DELETED' {
  if (trade.deletedAt) return 'DELETED'
  if (trade.deleteReason && !trade.deleteApprovedAt) return 'DELETE_PENDING'
  if (Array.isArray(trade.editHistory) && trade.editHistory.some(row => row.action === 'EDITED')) return 'EDITED'
  return 'ACTIVE'
}

function tradeStatusClass(status: ReturnType<typeof tradeStatus>) {
  if (status === 'DELETED') return 'tone-red'
  if (status === 'DELETE_PENDING') return 'tone-amber'
  if (status === 'EDITED') return 'tone-blue'
  return 'tone-green'
}

function TodayCell({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.04] p-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-2 text-lg font-bold ${className || 'text-cream'}`}>{value}</p>
    </div>
  )
}

function TradeList({ rows, isSuperAdmin, onAction }: { rows: TradingTrade[]; isSuperAdmin: boolean; onAction: (mode: TradeActionMode, trade: TradingTrade) => void }) {
  if (!rows.length) return <Empty icon="◇" title="No trades yet" />
  return (
    <div className="divide-y divide-white/[0.06]">
      {rows.map(r => {
        const status = tradeStatus(r)
        const active = status !== 'DELETED' && status !== 'DELETE_PENDING'
        return (
          <div key={r.id} className={`grid gap-2 px-4 py-3 text-xs transition-colors hover:bg-white/[0.04] md:grid-cols-[1fr_0.55fr_0.8fr_0.8fr_0.9fr_0.9fr_0.8fr_1.2fr] ${status === 'DELETED' ? 'opacity-60' : ''}`}>
            <span className="text-muted">{new Date(r.tradeDate).toLocaleString()}</span>
            <span className={r.tradeType === 'BUY' ? 'font-bold text-gold' : 'font-bold text-green-400'}>{r.tradeType}</span>
            <span className="text-muted-hi">{Number(r.usdtAmount).toLocaleString('en-BD')} USDT</span>
            <span className="text-muted-hi">Rate {Number(r.bdtRate || (r.tradeType === 'BUY' ? r.buyRateBdt : r.sellRateBdt)).toFixed(4)}</span>
            <span className="text-muted-hi">Fee <Money amount={Number(r.feeBdt || r.feeAmount)} /></span>
            <span className="text-muted-hi">{r.tradeType === 'BUY' ? 'Net cost' : 'Net receive'} <Money amount={Number(r.netBdt)} /></span>
            <span className={`font-bold ${r.tradeType === 'BUY' ? 'text-muted' : signedClass(r.netProfit)}`}>P/L <Money amount={Number(r.netProfit)} /></span>
            <span className="flex flex-wrap items-center gap-1">
              <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${tradeStatusClass(status)}`}>{status}</span>
              <Button size="xs" variant="ghost" onClick={() => onAction('audit', r)}>Audit</Button>
              {active && <Button size="xs" variant="secondary" onClick={() => onAction('edit', r)}>Edit</Button>}
              {active && <Button size="xs" variant="danger" onClick={() => onAction('request_delete', r)}>Request Delete</Button>}
              {isSuperAdmin && status === 'DELETE_PENDING' && <Button size="xs" variant="gold" onClick={() => onAction('approve_delete', r)}>Approve</Button>}
              {isSuperAdmin && status === 'DELETE_PENDING' && <Button size="xs" variant="ghost" onClick={() => onAction('reject_delete', r)}>Reject</Button>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function TradeActionModal({ action, onClose, onSaved }: { action: { mode: TradeActionMode; trade: TradingTrade } | null; onClose: () => void; onSaved: (res: { trade: TradingTrade; summary?: TradingSummary }) => void }) {
  const mutation = useUpdateTradingTrade()
  const tradeActionFormRef = useRef<HTMLFormElement>(null)
  const [form, setForm] = useState({ tradeType: 'BUY' as 'BUY' | 'SELL', usdtAmount: '', bdtRate: '', feeUsdt: '', tradeDate: '', notes: '', reason: '' })

  useEffect(() => {
    if (!action) return
    setForm({ tradeType: action.trade.tradeType, usdtAmount: String(action.trade.usdtAmount ?? ''), bdtRate: String(action.trade.bdtRate ?? ''), feeUsdt: String(action.trade.feeUsdt ?? ''), tradeDate: new Date(action.trade.tradeDate).toISOString().slice(0, 10), notes: action.trade.notes || '', reason: '' })
  }, [action])

  if (!action) return null
  const { mode, trade } = action
  const title = mode === 'audit' ? 'Trade Audit History' : mode === 'edit' ? 'Edit Trade Entry' : mode === 'request_delete' ? 'Request Trade Delete' : mode === 'approve_delete' ? 'Approve Trade Delete' : 'Reject Trade Delete'
  const history = Array.isArray(trade.editHistory) ? trade.editHistory : []

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (mode === 'audit') return
    const reason = form.reason.trim()
    if (reason.length < 5) { toast.error('Reason must be at least 5 characters'); return }
    const payload: TradingTradeActionInput = mode === 'edit'
      ? { action: 'edit', tradeType: form.tradeType, usdtAmount: Number(form.usdtAmount || 0), bdtRate: Number(form.bdtRate || 0), feeUsdt: Number(form.feeUsdt || 0), tradeDate: form.tradeDate, notes: form.notes, editReason: reason }
      : mode === 'request_delete' ? { action: 'request_delete', deleteReason: reason }
        : mode === 'approve_delete' ? { action: 'approve_delete' }
          : { action: 'reject_delete', rejectionReason: reason }
    const res = await mutation.mutate(trade.id, payload)
    if (!res?.ok) { toast.error(mutation.error || 'Trade action failed'); return }
    toast.success(mode === 'edit' ? 'Trade updated' : mode === 'request_delete' ? 'Delete request sent to Super Admin' : mode === 'approve_delete' ? 'Trade soft-deleted' : 'Delete request rejected')
    onSaved(res)
    onClose()
  }

  const submitLabel = mutation.loading ? <><Spinner /> Processing</> : mode === 'edit' ? 'Save edit' : mode === 'request_delete' ? 'Send delete request' : mode === 'approve_delete' ? 'Approve soft delete' : 'Reject request'

  return (
    <MobileModalPortal open zIndex={10000} onBackdropClick={onClose} aria-label={title}>
      <Card className="mobile-modal-shell w-full max-w-2xl rounded-2xl border-gold/20 bg-card/85 shadow-2xl sm:rounded-2xl">
        <div className="mobile-modal-header p-5 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-cream">{title}</p>
              <p className="mt-1 text-[11px] text-muted">{trade.tradeType} {Number(trade.usdtAmount).toLocaleString('en-BD')} USDT · {tradeStatus(trade)}</p>
            </div>
            <Button size="xs" variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </div>
        {mode === 'audit' ? (
          <div className="mobile-modal-body space-y-3 px-5 pb-4">
            {!history.length ? <Empty icon="◇" title="No audit history yet" /> : history.slice().reverse().map((row, idx) => (
              <div key={`${row.timestamp}-${idx}`} className="rounded-2xl border border-white/[0.06] bg-white/[0.04] p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold text-gold">{row.action}</span>
                  <span className="text-muted">{new Date(row.timestamp).toLocaleString()}</span>
                </div>
                <p className="mt-2 text-muted-hi">Reason: {row.reason}</p>
                <p className="mt-1 text-muted">Actor: {row.actorRole} · {row.actorUserId}</p>
              </div>
            ))}
          </div>
        ) : (
          <form ref={tradeActionFormRef} id="trade-action-form" onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="mobile-modal-body space-y-3 px-5 pb-4">
            {mode === 'edit' && (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <Select value={form.tradeType} onChange={v => setForm(f => ({ ...f, tradeType: v as 'BUY' | 'SELL' }))} options={[{ label: 'BUY', value: 'BUY' }, { label: 'SELL', value: 'SELL' }]} />
                  <Input inputMode="decimal" type="number" min="0" step="any" value={form.usdtAmount} onChange={e => setForm(f => ({ ...f, usdtAmount: e.target.value }))} placeholder="USDT amount" />
                  <Input inputMode="decimal" type="number" min="0" step="any" value={form.bdtRate} onChange={e => setForm(f => ({ ...f, bdtRate: e.target.value }))} placeholder="BDT rate" />
                  <Input inputMode="decimal" type="number" min="0" step="any" value={form.feeUsdt} onChange={e => setForm(f => ({ ...f, feeUsdt: e.target.value }))} placeholder="Fee USDT" />
                </div>
                <Input type="date" value={form.tradeDate} onChange={e => setForm(f => ({ ...f, tradeDate: e.target.value }))} />
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="min-h-20 w-full rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3 text-sm text-cream outline-none focus:border-gold/30" placeholder="Notes" />
              </>
            )}
            {mode === 'approve_delete' && (
              <div className="rounded-2xl border tone-amber p-3 text-xs">
                Approving will soft-delete this trade and immediately recalculate account P/L and daily snapshots. Reason: {trade.deleteReason || 'No reason recorded'}
              </div>
            )}
            {mode !== 'approve_delete' && (
              <textarea value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="min-h-20 w-full rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3 text-sm text-cream outline-none focus:border-gold/30" placeholder={mode === 'edit' ? 'Edit reason (required)' : mode === 'request_delete' ? 'Delete reason (required)' : 'Rejection reason (required)'} />
            )}
            {mutation.error && <p className="rounded-xl border tone-red px-3 py-2 text-xs">{mutation.error}</p>}
            </div>
            <div className="mobile-modal-footer px-5 pt-3">
              <Button type="button" variant={mode === 'request_delete' || mode === 'approve_delete' ? 'danger' : 'gold'} className="w-full justify-center" disabled={mutation.loading} onClick={() => tradeActionFormRef.current?.requestSubmit()}>
                {submitLabel}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </MobileModalPortal>
  )
}

function paidByLabel(paidBy?: string | null) {
  if (paidBy === 'OWNER') return 'Owner'
  if (paidBy === 'STAFF') return 'Staff'
  return '—'
}

function ExpenseList({ rows, showPaidBy }: { rows: TradingExpense[]; showPaidBy?: boolean }) {
  if (!rows.length) return <Empty icon="◇" title="No expenses yet" />
  return (
    <div className="divide-y divide-white/[0.06]">
      {rows.map(r => (
        <div key={r.id} className={`grid gap-2 px-4 py-3 text-xs transition-colors hover:bg-white/[0.04] ${showPaidBy ? 'md:grid-cols-[1fr_1fr_1fr_1fr_2fr]' : 'md:grid-cols-[1fr_1fr_1fr_2fr]'}`}>
          <span className="text-muted">{new Date(r.expenseDate).toLocaleDateString()}</span>
          <span className="font-bold text-cream">{r.expenseType}</span>
          {showPaidBy && <span className="font-bold text-muted-hi">{paidByLabel(r.paidBy)}</span>}
          <span className="font-bold text-red-400"><Money amount={Number(r.amount)} /></span>
          <span className="truncate text-muted">{r.notes || r.attachmentUrl || 'No notes'}</span>
        </div>
      ))}
    </div>
  )
}

function PartnershipSettlementPanel({ accountId, isAdmin, onSettled }: { accountId: string; isAdmin: boolean; onSettled: () => void }) {
  const { data, loading, refetch } = useTradingPartnership(accountId)
  const { mutate: settle, loading: settling } = useSettleTradingPartnership()
  const [settleOpen, setSettleOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const [override, setOverride] = useState('')
  const [postToWallet, setPostToWallet] = useState(false)

  const preview = data?.preview
  const history = data?.history ?? []

  async function confirmSettle() {
    const res = await settle(accountId, { notes, adminOverrideBdt: override.trim() ? Number(override) : null, postToWallet })
    if (!res?.ok) { toast.error('Settlement failed'); return }
    toast.success('Partnership settled')
    setSettleOpen(false); setNotes(''); setOverride(''); setPostToWallet(false)
    invalidateQueryCache('trading-partnership:'); invalidateQueryCache('trading-account:')
    refetch(); onSettled()
  }

  if (loading && !data) return <div className="p-6"><Spinner /></div>
  if (!preview?.partnershipEnabled) return <Empty icon="◇" title="Partnership not enabled" />

  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <SettlementKpi label="Period trading delta" value={preview.netTradingDeltaBdt} negativeIsBad />
        <SettlementKpi label="Owner-paid expenses" value={preview.ownerPaidExpensesBdt} />
        <SettlementKpi label="Staff-paid expenses" value={preview.staffPaidExpensesBdt} />
        <SettlementKpi label="Staff trading share" value={preview.staffTradingShareBdt} />
        <SettlementKpi label="Expense adjustment" value={preview.expenseAdjustmentBdt} />
        <SettlementKpi label="Net staff owes" value={preview.netStaffOwesBdt} highlight />
      </div>
      {preview.unsettledExpenses.length > 0 && (
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted">Unsettled expenses</p>
          <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.06]">
            {preview.unsettledExpenses.map(e => (
              <div key={e.id} className="grid gap-2 px-3 py-2 text-xs md:grid-cols-[1fr_1fr_1fr_2fr]">
                <span className="text-muted">{new Date(e.expenseDate).toLocaleDateString()}</span>
                <span className="text-cream">{e.expenseType}</span>
                <span className="text-muted-hi">{paidByLabel(e.paidBy)}</span>
                <span className="font-bold text-red-400"><Money amount={Number(e.amount)} /></span>
              </div>
            ))}
          </div>
        </div>
      )}
      {isAdmin && <Button variant="gold" onClick={() => setSettleOpen(true)} disabled={settling}>Settle now</Button>}
      {history.length > 0 && (
        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted">Settlement history</p>
          <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.06]">
            {history.map((row: TradingPartnershipSettlement) => (
              <div key={row.id} className="grid gap-2 px-3 py-3 text-xs md:grid-cols-[1fr_1fr_1fr_2fr]">
                <span className="text-muted">{new Date(row.periodEnd).toLocaleDateString()}</span>
                <span className="font-bold text-cream"><Money amount={Number(row.netStaffOwesBdt)} /></span>
                <span className="text-muted">{row.settledBy?.name || 'Admin'}</span>
                <span className="truncate text-muted">{row.notes || '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <MobileModalPortal open={settleOpen} onBackdropClick={() => setSettleOpen(false)}>
        <Card className="mx-auto w-full max-w-md rounded-2xl bg-card/85 p-5">
          <p className="text-sm font-bold text-cream">Confirm settlement</p>
          <p className="mt-1 text-[11px] text-muted">Suggested net staff owes: <Money amount={preview.netStaffOwesBdt} />{preview.netStaffOwesBdt > 0 ? ' (staff → owner)' : preview.netStaffOwesBdt < 0 ? ' (owner → staff)' : ''}</p>
          <div className="mt-4 space-y-3">
            <textarea value={notes} onChange={e => setNotes(e.target.value)} className="min-h-16 w-full rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3 text-sm text-cream outline-none" placeholder="Notes (optional)" />
            <Input inputMode="decimal" type="number" step="0.01" value={override} onChange={e => setOverride(e.target.value)} placeholder="Admin override amount (optional)" />
            <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={postToWallet} onChange={e => setPostToWallet(e.target.checked)} />Post to staff payroll wallet</label>
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setSettleOpen(false)}>Cancel</Button>
              <Button variant="gold" className="flex-1" disabled={settling} onClick={() => void confirmSettle()}>{settling ? <><Spinner /> Settling</> : 'Confirm settle'}</Button>
            </div>
          </div>
        </Card>
      </MobileModalPortal>
    </div>
  )
}

function SettlementKpi({ label, value, highlight, negativeIsBad }: { label: string; value: number; highlight?: boolean; negativeIsBad?: boolean }) {
  const color = highlight ? value > 0 ? 'text-amber-500' : value < 0 ? 'text-green-400' : 'text-muted-hi' : negativeIsBad && value < 0 ? 'text-red-400' : 'text-cream'
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.04] p-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 text-lg font-bold ${color}`}><Money amount={value} /></p>
    </div>
  )
}

function DailySummaryPanel({ accountId, rows, onCreated }: { accountId: string; rows: TradingBkashDailySummary[]; onCreated: (res: TradingMutationResponse) => void }) {
  const mutation = useAddTradingBkashSummary()
  const [summaryDate, setSummaryDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [totalOrders, setTotalOrders] = useState('')
  const [totalProfitBdt, setTotalProfitBdt] = useState('')
  const [totalLossBdt, setTotalLossBdt] = useState('')
  const [notes, setNotes] = useState('')
  const netResult = Number(totalProfitBdt || 0) - Number(totalLossBdt || 0)

  async function submit() {
    const res = await mutation.mutate({ tradingAccountId: accountId, summaryDate, totalOrders: Number(totalOrders || 0), totalProfitBdt: Number(totalProfitBdt || 0), totalLossBdt: Number(totalLossBdt || 0), notes })
    if (!res) return
    onCreated(res); setTotalOrders(''); setTotalProfitBdt(''); setTotalLossBdt(''); setNotes('')
  }

  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[0.8fr_1.2fr]">
      <Card className="rounded-2xl p-4">
        <p className="text-sm font-bold text-cream">Bkash Daily Summary</p>
        <p className="mt-1 text-xs text-muted">Quick result mode for high-volume Bkash micro-trading. Net result is profit minus loss.</p>
        <div className="mt-4 grid gap-3">
          <label className="text-xs font-bold text-muted">Date<input type="date" value={summaryDate} onChange={e => setSummaryDate(e.target.value)} className="mt-1 w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2 text-cream" /></label>
          <label className="text-xs font-bold text-muted">Total Orders<input type="number" min="0" step="1" value={totalOrders} onChange={e => setTotalOrders(e.target.value)} className="mt-1 w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2 text-cream" /></label>
          <label className="text-xs font-bold text-muted">Total Profit (BDT)<input type="number" min="0" step="0.01" value={totalProfitBdt} onChange={e => setTotalProfitBdt(e.target.value)} className="mt-1 w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2 text-cream" /></label>
          <label className="text-xs font-bold text-muted">Total Loss (BDT)<input type="number" min="0" step="0.01" value={totalLossBdt} onChange={e => setTotalLossBdt(e.target.value)} className="mt-1 w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2 text-cream" /></label>
          <label className="text-xs font-bold text-muted">Notes<textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="mt-1 w-full rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2 text-cream" /></label>
          <div className={`rounded-2xl border p-3 text-sm font-bold ${netResult >= 0 ? 'tone-green' : 'tone-red'}`}>Net Result: ৳{netResult.toLocaleString('en-BD')}</div>
          <Button variant="gold" onClick={submit} disabled={mutation.loading}>Save Bkash Summary</Button>
          {mutation.error && <p className="text-xs text-red-500">{mutation.error}</p>}
        </div>
      </Card>
      <div className="divide-y divide-white/[0.06] rounded-2xl border border-white/[0.06]">
        {!rows.length ? <Empty icon="◇" title="No Bkash summaries yet" /> : rows.map(row => (
          <div key={row.id} className="grid gap-2 px-4 py-3 text-xs md:grid-cols-[1fr_0.8fr_1fr_1fr_1fr_1.4fr]">
            <span className="text-muted">{new Date(row.summaryDate).toLocaleDateString()}</span>
            <span className="text-muted-hi">{row.totalOrders.toLocaleString('en-BD')} orders</span>
            <span className="text-green-400">Profit <Money amount={Number(row.totalProfitBdt)} /></span>
            <span className="text-red-400">Loss <Money amount={Number(row.totalLossBdt)} /></span>
            <span className={`font-bold ${signedClass(Number(row.netResultBdt))}`}>Net <Money amount={Number(row.netResultBdt)} /></span>
            <span className="truncate text-muted">{row.notes || 'No notes'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PerformancePanel({ accountId, rows, onUploaded }: { accountId: string; rows: TradingPerformanceScreenshot[]; onUploaded: (shot: TradingPerformanceScreenshot) => void }) {
  const mutation = useUploadTradingPerformanceScreenshot()
  const [shotDate, setShotDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)

  async function submit() {
    if (!file) return
    const optimized = await optimizeTradingScreenshot(file)
    const res = await mutation.mutate(accountId, optimized, { shotDate, note })
    if (!res) return
    onUploaded(res.screenshot); setFile(null); setNote('')
  }

  const before = rows[rows.length - 1]
  const after = rows[0]
  return (
    <div className="space-y-4 p-4">
      <Card className="rounded-2xl p-4">
        <p className="text-sm font-bold text-cream">Performance Timeline</p>
        <p className="mt-1 text-xs text-muted">Upload daily Binance profile screenshots. Only the latest 7 stay visible; older images are archived and paginated by the API.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_2fr_auto]">
          <input type="date" value={shotDate} onChange={e => setShotDate(e.target.value)} className="rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2 text-sm text-cream" />
          <input type="file" accept="image/*" onChange={e => { setFile(e.target.files?.[0] ?? null); e.target.value = '' }} className="rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2 text-sm text-muted-hi" />
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Growth note, order count, completion rate..." className="rounded-xl border border-white/[0.06] bg-card/85 px-3 py-2 text-sm text-cream" />
          <Button variant="gold" onClick={submit} disabled={!file || mutation.loading}>Upload</Button>
        </div>
        {mutation.error && <p className="mt-2 text-xs text-red-500">{mutation.error}</p>}
      </Card>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {!rows.length ? <Empty icon="◇" title="No screenshots yet" /> : rows.map(shot => (
          <a key={shot.id} href={shot.signedUrl} target="_blank" rel="noreferrer" className="overflow-hidden rounded-2xl border border-white/[0.06] bg-card/85">
            {shot.signedUrl && <img src={shot.signedUrl} alt={shot.note || 'Performance screenshot'} loading="lazy" className="aspect-[4/3] w-full object-cover" />}
            <div className="p-3 text-xs">
              <p className="font-bold text-cream">{new Date(shot.shotDate).toLocaleDateString()}</p>
              <p className="mt-1 line-clamp-2 text-muted">{shot.note || 'No note'}</p>
            </div>
          </a>
        ))}
      </div>
      {before?.signedUrl && after?.signedUrl && before.id !== after.id && (
        <Card className="rounded-2xl p-4">
          <p className="text-sm font-bold text-cream">Before vs After</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <ComparisonShot label="Before" shot={before} />
            <ComparisonShot label="After" shot={after} />
          </div>
        </Card>
      )}
    </div>
  )
}

function ComparisonShot({ label, shot }: { label: string; shot: TradingPerformanceScreenshot }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.06] bg-card/85">
      {shot.signedUrl && <img src={shot.signedUrl} alt={`${label} merchant profile`} loading="lazy" className="aspect-[16/10] w-full object-cover" />}
      <div className="p-3 text-xs"><span className="font-bold text-gold">{label}</span> · {new Date(shot.shotDate).toLocaleDateString()}</div>
    </div>
  )
}

function StaffPanel({ account, summary, capitalEntries, timeline }: { account: TradingAccount; summary: TradingSummary; capitalEntries: TradingCapitalEntry[]; timeline: Array<{ id: string; type: string; occurredAt: string; label: string; amount: number; runningBalance: number; runningProfit: number }> }) {
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <StatRow label="Assigned staff" value={account.assignedUser?.name || 'Unassigned'} />
        <StatRow label="Employee ID" value={account.assignedUser?.employeeIdGas || 'Not linked'} />
        <StatRow label="Salary hint" value={<Money amount={Number(account.assignedUser?.salaryHint || 0)} />} />
        <StatRow label="Commission type" value={account.commissionType.replace('_', ' ')} />
        <StatRow label="Commission value" value={account.commissionType === 'PERCENTAGE' ? `${Number(account.commissionRate).toFixed(2)}% of profitable sells` : <Money amount={Number(account.fixedCommission)} />} />
        <StatRow label="Completion bonus" value={<Money amount={Number(account.completionBonus)} />} />
        <StatRow label="Initial Capital" value={<Money amount={summary.startingCapital} />} />
        <StatRow label="Current balance" value={<Money amount={summary.currentBalance} />} valueClass={summary.currentBalance < 0 ? 'text-red-400' : 'text-cream'} />
        <StatRow label="Total traded USDT" value={summary.totalTradedUsdt.toLocaleString('en-BD')} />
        <StatRow label="Total buy volume" value={`${summary.totalBuyUsdt.toLocaleString('en-BD')} USDT / ৳${summary.totalBuyBdt.toLocaleString('en-BD')}`} />
        <StatRow label="Total sell volume" value={`${summary.totalSellUsdt.toLocaleString('en-BD')} USDT / ৳${summary.totalSellBdt.toLocaleString('en-BD')}`} />
        <StatRow label="USDT balance" value={summary.usdtBalance.toLocaleString('en-BD')} />
        <StatRow label="Inventory cost" value={<Money amount={summary.inventoryCostBdt} />} />
        <StatRow label="Average spread" value={summary.averageSpread.toFixed(4)} valueClass={signedClass(summary.averageSpread)} />
        <StatRow label="Net trading profit" value={<Money amount={summary.netTradingProfit} />} valueClass={signedClass(summary.netTradingProfit)} />
        <StatRow label="Net operational profit" value={<Money amount={summary.netOperationalProfit} />} valueClass={signedClass(summary.netOperationalProfit)} />
        <StatRow label="Total expenses" value={<Money amount={summary.totalExpenses} />} valueClass="text-red-400" />
        <StatRow label="Total withdrawals" value={<Money amount={summary.totalWithdrawals} />} valueClass="text-muted-hi" />
        <StatRow label="Net ROI" value={`${summary.roiPct.toFixed(2)}%`} valueClass={signedClass(summary.roiPct)} />
        <StatRow label="Merchant Goal / Monthly Target" value={summary.merchantTarget == null ? 'Not set' : <Money amount={summary.merchantTarget} />} />
      </div>
      <div>
        <p className="mb-2 text-sm font-bold text-cream">Capital ledger</p>
        {!capitalEntries.length ? <Empty icon="◇" title="No capital entries yet" /> : (
          <div className="divide-y divide-white/[0.06] rounded-2xl border border-white/[0.06]">
            {capitalEntries.map(r => <div key={r.id} className="grid gap-2 px-4 py-3 text-xs md:grid-cols-[1fr_1fr_1fr_2fr]"><span className="text-muted">{new Date(r.createdAt).toLocaleString()}</span><span className="font-bold text-cream">{r.entryType}</span><span className="font-bold text-gold"><Money amount={Number(r.amount)} /></span><span className="truncate text-muted">{r.notes || 'No notes'}</span></div>)}
          </div>
        )}
      </div>
      <div>
        <p className="mb-2 text-sm font-bold text-cream">Running timeline</p>
        {!timeline.length ? <Empty icon="◇" title="No timeline yet" /> : (
          <div className="divide-y divide-white/[0.06] rounded-2xl border border-white/[0.06]">
            {timeline.slice(0, 30).map(item => (
              <div key={`${item.type}-${item.id}`} className="grid gap-2 px-4 py-3 text-xs md:grid-cols-[1fr_1fr_1fr_1fr]">
                <span className="text-muted">{new Date(item.occurredAt).toLocaleString()}</span>
                <span className="font-bold text-cream">{item.type} · {item.label}</span>
                <span className={signedClass(item.amount)}>Delta ৳{item.amount.toLocaleString('en-BD')}</span>
                <span className={signedClass(item.runningBalance)}>Balance ৳{item.runningBalance.toLocaleString('en-BD')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
