'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { motion } from 'framer-motion'
import { Card, Empty, KpiCard, KPI_AUTO_GRID, Money, Skeleton, Button } from '@/components/ui'
import { ResponsiveKpiValue } from '@/components/ui/ResponsiveKpiValue'
import { TradingPageShell } from '@/components/trading/TradingPageShell'
import { TradingQuickActions, TradingStickyBar, type TradingWorkflowAction } from '@/components/trading/TradingWorkflowActions'
import { MyTradingAccounts } from '@/components/trading/MyTradingAccounts'
import { useTradingAccounts, useTradingDashboard, useTradingSummary } from '@/hooks/useTrading'
import { useActor } from '@/contexts/ActorContext'
import { money, signedClass } from '@/components/trading/trading-utils'
import { getTradingAlertCta } from '@/lib/trading-alert-cta'
import type { TradingDashboardResponse, TradingMutationResponse } from '@/types/trading'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25 } } }

const TradeEntryModal = dynamic(
  () => import('@/components/trading/TradingModals').then(mod => mod.TradeEntryModal),
  { ssr: false, loading: () => null },
)
const ScreenshotUploadModal = dynamic(
  () => import('@/components/trading/ScreenshotUploadModal').then(mod => mod.ScreenshotUploadModal),
  { ssr: false, loading: () => null },
)
const BkashDailySummaryModal = dynamic(
  () => import('@/components/trading/BkashDailySummaryModal').then(mod => mod.BkashDailySummaryModal),
  { ssr: false, loading: () => null },
)
const ExpenseEntryModal = dynamic(
  () => import('@/components/trading/TradingModals').then(mod => mod.ExpenseEntryModal),
  { ssr: false, loading: () => null },
)

type WorkflowModal = 'trade' | 'screenshot' | 'summary' | null

export default function TradingDashboardPage() {
  const router = useRouter()
  const { role } = useActor()
  const isAdmin = role === 'SUPER_ADMIN' || role === 'ADMIN'
  const { data, loading, refetch } = useTradingDashboard()
  const { data: businessSummary, loading: summaryLoading, refetch: refetchSummary } = useTradingSummary()
  const { data: accountData, refetch: refetchAccounts } = useTradingAccounts({ status: 'ACTIVE' })
  const [workflowModal, setWorkflowModal] = useState<WorkflowModal>(null)
  const [workflowAccountId, setWorkflowAccountId] = useState<string | undefined>()
  const [tradeInitialMode, setTradeInitialMode] = useState<'BKASH' | 'BANK'>('BANK')
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [optimisticScreenshots, setOptimisticScreenshots] = useState<Record<string, import('@/types/trading').TradingPerformanceScreenshot[]>>({})

  const bk = businessSummary?.kpis
  const highlightScreenshot = (data?.screenshotCompliance?.overdueCount ?? 0) > 0 || (data?.screenshotCompliance?.dueCount ?? 0) > 0
  const accounts = accountData?.accounts ?? []
  const tradeAccount = useMemo(
    () => accounts.find(a => a.id === workflowAccountId) ?? accounts[0] ?? null,
    [accounts, workflowAccountId],
  )

  const latest = useMemo(() => ({
    trades: data?.latestTrades ?? [],
    expenses: data?.latestExpenses ?? [],
    capital: data?.latestCapitalEntries ?? [],
  }), [data])

  const openWorkflow = useCallback((action: TradingWorkflowAction, accountId?: string) => {
    if (action === 'accounts') return
    setWorkflowAccountId(accountId || accounts[0]?.id)
    if (action === 'trade') {
      setTradeInitialMode('BANK')
      setWorkflowModal('trade')
    } else if (action === 'screenshot') {
      setWorkflowModal('screenshot')
    } else if (action === 'summary') {
      setTradeInitialMode('BKASH')
      setWorkflowModal('summary')
    }
  }, [accounts])

  const handleAlertCta = useCallback((alert: TradingDashboardResponse['alerts'][number]) => {
    const cta = getTradingAlertCta(alert.key)
    if (cta.action === 'view') {
      router.push(alert.actionUrl)
      return
    }
    openWorkflow(cta.action, alert.accountId)
  }, [openWorkflow, router])

  function refreshAfterMutation(_res: TradingMutationResponse) {
    refetch()
    refetchSummary()
    refetchAccounts()
  }

  return (
    <TradingPageShell
      title={isAdmin ? 'Trading Operations' : 'Daily trading desk'}
      subtitle={isAdmin ? 'Owner overview · staff workflow below' : 'Fast trade · screenshot · summary'}
      actions={
        isAdmin ? (
          <>
            <Link href="/trading/analytics"><Button variant="ghost" size="xs">Analytics</Button></Link>
            <Button variant="secondary" size="xs" onClick={() => setExpenseOpen(true)}>+ Expense</Button>
          </>
        ) : null
      }
    >
      <TradingStickyBar highlightScreenshot={highlightScreenshot} onAction={action => openWorkflow(action)} />

      <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-5">
      {data?.screenshotCompliance && (
        <motion.div variants={fadeUp}>
        <Card className="rounded-2xl border tone-amber p-4">
          <p className="text-sm font-bold">Screenshot compliance</p>
          <p className="mt-1 text-[11px] opacity-80">
            {data.screenshotCompliance.completeCount} complete · {data.screenshotCompliance.dueCount} due · {data.screenshotCompliance.overdueCount} overdue
            {data.screenshotCompliance.pastCutoff ? ' · cutoff passed' : ` · cutoff ${data.screenshotCompliance.cutoffHourBd}:00 BD`}
          </p>
        </Card>
        </motion.div>
      )}

      <motion.div variants={fadeUp}>
        <section aria-label="Quick actions">
          <TradingQuickActions highlightScreenshot={highlightScreenshot} onAction={action => openWorkflow(action)} />
        </section>
      </motion.div>

      <motion.div variants={fadeUp}>
        <MyTradingAccounts
          accounts={accounts}
          performance={(data?.accountPerformance ?? []).map(row => ({
            id: row.id,
            accountTitle: row.accountTitle,
            currentBalance: row.currentBalance,
            dailyPl: row.dailyPl,
            health: row.health,
            screenshotToday: row.screenshotToday,
            screenshotCompliance: row.screenshotCompliance,
          }))}
          loading={loading}
          onAction={(action, accountId) => openWorkflow(action, accountId)}
        />
      </motion.div>

      <motion.div variants={fadeUp}>
        <AlertsPanel
          alerts={data?.alerts ?? []}
          loading={loading}
          isAdmin={isAdmin}
          onCta={handleAlertCta}
        />
      </motion.div>

      <motion.div variants={fadeUp} className={KPI_AUTO_GRID}>
        <KpiCard label="Today net" value={data?.kpis.netTodayResult ?? 0} valueKind="currency" color={signedClass(data?.kpis.netTodayResult ?? 0)} loading={loading} />
        <KpiCard label="Current balance" value={data?.kpis.currentBalance ?? 0} valueKind="currency" color="text-gold" loading={loading} />
        <KpiCard label="Today profit" value={data?.kpis.todayProfit ?? 0} valueKind="currency" color="text-green-400" loading={loading} />
        <KpiCard label="Today loss" value={data?.kpis.todayLoss ?? 0} valueKind="currency" color="text-red-400" loading={loading} />
        {isAdmin && (
          <>
            <KpiCard label="Active accounts" value={data?.kpis.activeAccounts ?? 0} valueKind="number" loading={loading} />
            <KpiCard label="Total capital" value={data?.kpis.totalCapital ?? bk?.totalCapital ?? 0} valueKind="currency" color="text-gold" loading={loading || summaryLoading} />
            <KpiCard label="Trade volume" value={data?.kpis.totalTradeVolume ?? 0} valueKind="currency" loading={loading} />
            <KpiCard label="USDT volume" value={data?.kpis.totalUsdtVolume ?? bk?.totalTradedUsdt ?? 0} valueKind="usdt" loading={loading || summaryLoading} />
          </>
        )}
      </motion.div>

      {isAdmin && (
        <>
          <motion.div variants={fadeUp} className={KPI_AUTO_GRID}>
            <KpiCard label="Total fees" value={bk?.totalFees ?? 0} valueKind="currency" color="text-amber-500" loading={summaryLoading} />
            <KpiCard label="Total expenses" value={data?.kpis.totalExpenses ?? bk?.totalOperatingExpenses ?? 0} valueKind="currency" color="text-red-400" loading={loading || summaryLoading} />
            <KpiCard label="Active staff" value={data?.kpis.activeStaffCount ?? 0} valueKind="number" loading={loading} />
            <KpiCard label="Total buy USDT" value={bk?.totalBuyUsdt ?? 0} valueKind="usdt" loading={summaryLoading} />
            <KpiCard label="Total sell USDT" value={bk?.totalSellUsdt ?? 0} valueKind="usdt" loading={summaryLoading} />
          </motion.div>

          <motion.div variants={fadeUp} className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <Card className="rounded-2xl p-5">
              <p className="text-sm font-bold text-cream">Merchant Growth & Capital Risk</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <MetricPill label="Avg growth score" value={`${(data?.merchantGrowth.averageScore ?? 0).toFixed(1)}%`} tone="text-green-400" />
                <MetricPill label="Growth trend" value={data?.merchantGrowth.trend ?? 'FLAT'} tone={data?.merchantGrowth.trend === 'UP' ? 'text-green-400' : data?.merchantGrowth.trend === 'DOWN' ? 'text-red-400' : 'text-blue-500'} />
                <MetricPill label="Capital utilization" value={`${(data?.capitalRisk.capitalUtilization ?? 0).toFixed(1)}%`} tone="text-amber-500" />
                <MetricPill label="Loss exposure" value={`${(data?.capitalRisk.lossExposure ?? 0).toFixed(1)}%`} tone="text-red-400" />
              </div>
              <MiniOpsTrend rows={data?.trend ?? []} />
            </Card>
            <Card className="rounded-2xl p-5">
              <p className="text-sm font-bold text-cream">Period snapshots</p>
              <div className="mt-3 space-y-2">
                {businessSummary && Object.entries(businessSummary.ranges).slice(0, 3).map(([label, range]) => (
                  <div key={label} className="flex items-center justify-between text-xs">
                    <span className="text-muted">{label === 'last7' ? 'Last 7 days' : label}</span>
                    <span className={`font-bold tabular-nums ${signedClass(range.netResultBdt ?? 0)}`}>
                      ৳{(range.netResultBdt ?? 0).toLocaleString('en-BD')}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </motion.div>

          <motion.div variants={fadeUp}>
            <AccountPerformanceTable rows={data?.accountPerformance ?? []} loading={loading} />
          </motion.div>

          <motion.div variants={fadeUp}>
          <Card className="overflow-hidden rounded-2xl">
            <div className="border-b border-white/[0.06] px-4 py-3">
              <p className="text-sm font-bold text-cream">Staff Performance Rankings</p>
            </div>
            {loading ? <div className="p-4"><Skeleton className="h-24" /></div> : !data?.staffRankings.rows.length ? (
              <Empty icon="◇" title="No staff performance yet" />
            ) : (
              <div className="divide-y divide-white/[0.06]">
                {data.staffRankings.rows.map(staff => (
                  <div key={staff.userId} className="grid gap-2 px-4 py-3 text-xs transition-colors hover:bg-white/[0.04] md:grid-cols-[1.2fr_0.8fr_0.9fr_0.9fr_0.9fr_0.9fr_0.9fr]">
                    <span className="font-bold text-cream">{staff.name}</span>
                    <span className="text-muted">{staff.managedAccounts} accounts</span>
                    <span className="text-gold">Capital ৳{staff.managedCapital.toLocaleString('en-BD')}</span>
                    <span className={signedClass(staff.totalProfitGenerated)}>Profit ৳{staff.totalProfitGenerated.toLocaleString('en-BD')}</span>
                    <span className="text-green-400">Commission ৳{staff.commissionEarned.toLocaleString('en-BD')}</span>
                    <span className="text-blue-500">Consistency {staff.activityConsistency.toFixed(0)}%</span>
                    <span className="font-bold text-cream">Score {staff.score.toFixed(0)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          </motion.div>
        </>
      )}

      <motion.div variants={fadeUp} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <RecentCard title="Latest Trades" empty="No trades today" loading={loading}>
          {latest.trades.map(trade => (
            <Link key={trade.id} href={`/trading/accounts/${trade.tradingAccountId}`} className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-white/[0.04]">
              <div className="min-w-0">
                <p className="truncate text-xs font-bold text-cream">{trade.tradingAccount?.accountTitle || trade.tradingAccountId}</p>
                <p className="mt-0.5 text-[10px] text-muted">{trade.user?.name || 'Staff'} · {trade.tradeType} · {money(trade.usdtAmount)} USDT</p>
              </div>
              <p className={`shrink-0 text-sm font-bold tabular-nums ${signedClass(trade.netProfit)}`}><Money amount={Number(trade.netProfit)} /></p>
            </Link>
          ))}
        </RecentCard>
        <RecentCard title="Latest Expenses" empty="No expenses" loading={loading}>
          {latest.expenses.map(expense => (
            <Link key={expense.id} href={`/trading/accounts/${expense.tradingAccountId}`} className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-white/[0.04]">
              <div className="min-w-0">
                <p className="truncate text-xs font-bold text-cream">{expense.expenseType}</p>
                <p className="mt-0.5 text-[10px] text-muted">{expense.tradingAccount?.accountTitle || expense.tradingAccountId}</p>
              </div>
              <p className="shrink-0 text-sm font-bold text-red-400 tabular-nums"><Money amount={Number(expense.amount)} /></p>
            </Link>
          ))}
        </RecentCard>
      </motion.div>
      </motion.div>

      <TradeEntryModal
        open={workflowModal === 'trade'}
        account={tradeAccount}
        accounts={accounts}
        initialMode={tradeInitialMode}
        onClose={() => setWorkflowModal(null)}
        onCreated={res => { refreshAfterMutation(res); setWorkflowModal(null) }}
      />
      <ScreenshotUploadModal
        open={workflowModal === 'screenshot'}
        accounts={accounts}
        defaultAccountId={workflowAccountId}
        recentByAccount={optimisticScreenshots}
        onClose={() => setWorkflowModal(null)}
        onUploaded={shot => {
          setOptimisticScreenshots(prev => ({
            ...prev,
            [shot.tradingAccountId]: [shot, ...(prev[shot.tradingAccountId] ?? [])].slice(0, 4),
          }))
          refetch()
        }}
      />
      <BkashDailySummaryModal
        open={workflowModal === 'summary'}
        accounts={accounts}
        defaultAccountId={workflowAccountId}
        onClose={() => setWorkflowModal(null)}
        onCreated={res => { refreshAfterMutation(res); setWorkflowModal(null) }}
      />
      <ExpenseEntryModal
        open={expenseOpen}
        accounts={accounts}
        onClose={() => setExpenseOpen(false)}
        onCreated={refreshAfterMutation}
      />
    </TradingPageShell>
  )
}

function AlertsPanel({
  alerts,
  loading,
  isAdmin,
  onCta,
}: {
  alerts: NonNullable<TradingDashboardResponse['alerts']>
  loading: boolean
  isAdmin: boolean
  onCta: (alert: TradingDashboardResponse['alerts'][number]) => void
}) {
  return (
    <Card className="overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div>
          <p className="text-sm font-bold text-cream">{isAdmin ? 'Action required' : 'Your tasks'}</p>
          <p className="text-[11px] text-muted">Tap Upload Now or Add Summary to fix alerts</p>
        </div>
        <span className="rounded-full tone-red px-2 py-1 text-[10px] font-bold">{alerts.length}</span>
      </div>
      {loading ? <div className="p-4"><Skeleton className="h-28" /></div> : !alerts.length ? (
        <Empty icon="✓" title="All clear — no pending tasks" />
      ) : (
        <div className="divide-y divide-white/[0.06]">
          {alerts.slice(0, 8).map(alert => {
            const cta = getTradingAlertCta(alert.key)
            return (
              <div key={alert.key} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-cream">{alert.title}</p>
                    <p className="mt-1 text-[11px] text-muted">{alert.message}</p>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-bold ${alertTone(alert.severity)}`}>{alert.severity}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="xs" variant="gold" onClick={() => onCta(alert)}>{cta.label}</Button>
                  <Link href={alert.actionUrl}>
                    <Button size="xs" variant="ghost">View account</Button>
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function AccountPerformanceTable({ rows, loading }: { rows: TradingDashboardResponse['accountPerformance']; loading: boolean }) {
  return (
    <Card className="overflow-hidden rounded-2xl">
      <div className="border-b border-white/[0.06] px-4 py-3">
        <p className="text-sm font-bold text-cream">Account Performance & Health</p>
      </div>
      {loading ? <div className="p-4"><Skeleton className="h-32" /></div> : !rows.length ? <Empty icon="◇" title="No account performance yet" /> : (
        <div className="table-scroll">
          <div className="min-w-[1080px] divide-y divide-white/[0.06]">
            <div className="grid grid-cols-[1.4fr_0.9fr_0.8fr_0.8fr_0.6fr_0.7fr_0.7fr_0.8fr_0.9fr_0.8fr] gap-3 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-muted">
              <span>Account</span><span>Balance</span><span>Daily P/L</span><span>Weekly P/L</span><span>ROI</span><span>Expense</span><span>Fees</span><span>Progress</span><span>Staff</span><span>Health</span>
            </div>
            {rows.slice(0, 20).map(row => (
              <Link key={row.id} href={`/trading/accounts/${row.id}`} className="grid grid-cols-[1.4fr_0.9fr_0.8fr_0.8fr_0.6fr_0.7fr_0.7fr_0.8fr_0.9fr_0.8fr] gap-3 px-4 py-3 text-xs transition-colors hover:bg-white/[0.04]">
                <span><b className="text-cream">{row.accountTitle}</b><br /><span className="text-[10px] text-muted">{row.activityStatus.replace('_', ' ')} · {row.inactiveDays}d idle</span></span>
                <span className="text-gold">৳{row.currentBalance.toLocaleString('en-BD')}</span>
                <span className={signedClass(row.dailyPl)}>৳{row.dailyPl.toLocaleString('en-BD')}</span>
                <span className={signedClass(row.weeklyPl)}>৳{row.weeklyPl.toLocaleString('en-BD')}</span>
                <span className={signedClass(row.roi)}>{row.roi.toFixed(1)}%</span>
                <span className={row.expenseRatio > 35 ? 'text-red-400' : 'text-muted'}>{row.expenseRatio.toFixed(1)}%</span>
                <span className="text-amber-500">৳{row.feeTotals.toLocaleString('en-BD')}</span>
                <span className="text-muted-hi">{row.merchantProgress.toFixed(1)}%</span>
                <span className="text-muted">{row.assignedStaff}</span>
                <HealthBadge health={row.health} />
              </Link>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

function HealthBadge({ health }: { health: TradingDashboardResponse['accountPerformance'][number]['health'] }) {
  const cls = health === 'PROFITABLE' ? 'tone-green' : health === 'STABLE' ? 'tone-blue' : health === 'RISK' ? 'tone-amber' : 'tone-red'
  return <span className={`h-fit rounded-full border px-2 py-1 text-[10px] font-bold ${cls}`}>{health}</span>
}

function MetricPill({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/[0.06] bg-white/[0.04] p-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-2 min-w-0 break-words text-[clamp(0.875rem,0.5rem+0.8vw,1.125rem)] font-bold leading-tight tabular-nums ${tone}`}>{value}</p>
    </div>
  )
}

function MiniOpsTrend({ rows }: { rows: TradingDashboardResponse['trend'] }) {
  const points = rows.slice(-14)
  if (!points.length) return <div className="mt-4"><Empty icon="◇" title="No trend data yet" /></div>
  const min = Math.min(...points.map(p => p.netBdt), 0)
  const max = Math.max(...points.map(p => p.netBdt), 1)
  const path = points.map((p, i) => {
    const x = points.length === 1 ? 0 : (i / (points.length - 1)) * 100
    const y = 100 - ((p.netBdt - min) / Math.max(1, max - min)) * 100
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
  return (
    <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.04] p-3">
      <svg viewBox="0 0 100 100" className="h-28 w-full overflow-visible">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="3" className="text-gold" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="text-[11px] text-muted">Last {points.length} days net profit trend</p>
    </div>
  )
}

function alertTone(severity: TradingDashboardResponse['alerts'][number]['severity']) {
  if (severity === 'CRITICAL') return 'tone-red'
  if (severity === 'HIGH') return 'tone-orange'
  if (severity === 'MEDIUM') return 'tone-amber'
  return 'tone-blue'
}

function RecentCard({ title, empty, loading, children }: { title: string; empty: string; loading: boolean; children: React.ReactNode }) {
  const hasItems = Array.isArray(children) ? children.length > 0 : Boolean(children)
  return (
    <Card className="overflow-hidden rounded-2xl">
      <div className="border-b border-white/[0.06] px-4 py-3">
        <p className="text-sm font-bold text-cream">{title}</p>
      </div>
      {loading ? (
        <div className="p-4"><Skeleton className="h-28" /></div>
      ) : hasItems ? (
        <div className="divide-y divide-white/[0.06]">{children}</div>
      ) : (
        <Empty icon="◇" title={empty} />
      )}
    </Card>
  )
}
