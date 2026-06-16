'use client'
import { useDeferredValue, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, Empty, KpiCard, KPI_AUTO_GRID, SearchInput, Select, Skeleton } from '@/components/ui'
import { TradingPageShell } from '@/components/trading/TradingPageShell'
import { MiniTrendChart, RankingBars } from '@/components/trading/TradingAnalyticsCharts'
import { useTradingAccounts, useTradingAnalytics, useTradingStaff } from '@/hooks/useTrading'
import type { TradingAnalyticsAccount, TradingAnalyticsResponse } from '@/types/trading'
import { downloadBlob } from '@/lib/export-payroll-wallet'
import { signedClass, statusClass } from '@/components/trading/trading-utils'

const today = new Date()
const defaultStart = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
const defaultEnd = today.toISOString().slice(0, 10)

export default function TradingAnalyticsPage() {
  const [filters, setFilters] = useState({
    startDate: defaultStart,
    endDate: defaultEnd,
    staffId: '',
    accountId: '',
    status: 'ALL',
    profitability: 'ALL',
    minRoi: '',
    maxRoi: '',
  })
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const { data, loading, refetch } = useTradingAnalytics(filters)
  const { data: accountsData } = useTradingAccounts({ status: 'ALL' })
  const { data: staffData } = useTradingStaff()

  const searchedRows = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    const rows = data?.reportRows ?? []
    if (!needle) return rows
    return rows.filter(r => [r.accountTitle, r.assignedUserName, r.health, r.status].some(v => String(v).toLowerCase().includes(needle)))
  }, [data?.reportRows, deferredSearch])
  const maxExpenseCategory = useMemo(
    () => Math.max(...(data?.expenseCategories ?? []).map(c => c.amount), 1),
    [data?.expenseCategories],
  )

  async function exportCsv() {
    if (!data) return
    downloadBlob('alma-trading-analytics.csv', new Blob([toCsv(searchedRows)], { type: 'text/csv;charset=utf-8' }))
    toast.success('CSV exported')
  }

  async function exportExcel() {
    if (!data) return
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.json_to_sheet(reportJson(searchedRows))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Trading Analytics')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    downloadBlob('alma-trading-analytics.xlsx', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    toast.success('Excel exported')
  }

  async function exportPdf() {
    if (!data) return
    const { pdf, Document, Page, Text, View, StyleSheet } = await import('@react-pdf/renderer')
    const styles = StyleSheet.create({
      page: { padding: 32, fontSize: 10, color: '#111' },
      title: { fontSize: 18, fontWeight: 700, marginBottom: 8 },
      sub: { fontSize: 10, marginBottom: 18 },
      section: { marginTop: 12 },
      heading: { fontSize: 13, fontWeight: 700, marginBottom: 6 },
      row: { marginBottom: 4 },
    })
    const doc = (
      <Document>
        <Page size="A4" style={styles.page}>
          <Text style={styles.title}>Alma Trading Analytics Report</Text>
          <Text style={styles.sub}>Managed capital: BDT {data.kpis.totalManagedCapital.toLocaleString('en-BD')} · Monthly net: BDT {data.kpis.monthlyNet.toLocaleString('en-BD')}</Text>
          <View style={styles.section}>
            <Text style={styles.heading}>Top Accounts</Text>
            {data.topProfitableAccounts.slice(0, 10).map(row => (
              <Text key={row.id} style={styles.row}>{row.accountTitle} · Net BDT {row.netProfit.toLocaleString('en-BD')} · ROI {row.roi.toFixed(2)}%</Text>
            ))}
          </View>
          <View style={styles.section}>
            <Text style={styles.heading}>Alerts</Text>
            {data.alerts.length ? data.alerts.slice(0, 10).map(alert => (
              <Text key={`${alert.type}-${alert.accountId}`} style={styles.row}>{alert.type}: {alert.accountTitle} · {alert.message}</Text>
            )) : <Text style={styles.row}>No analytics alerts.</Text>}
          </View>
        </Page>
      </Document>
    )
    const blob = await pdf(doc).toBlob()
    downloadBlob('alma-trading-analytics.pdf', blob)
    toast.success('PDF exported')
  }

  const k = data?.kpis

  return (
    <TradingPageShell
      title="Trading Analytics"
      subtitle="Management intelligence · profitability · staff performance"
      actions={<div className="flex flex-wrap gap-2"><Button size="xs" variant="secondary" onClick={() => refetch()}>Refresh</Button><Button size="xs" variant="secondary" disabled={!data} onClick={() => void exportCsv()}>CSV</Button><Button size="xs" variant="secondary" disabled={!data} onClick={() => void exportExcel()}>Excel</Button><Button size="xs" variant="gold" disabled={!data} onClick={() => void exportPdf()}>PDF</Button></div>}
    >
      <Card className="p-4">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4 xl:grid-cols-8">
          <input type="date" value={filters.startDate} onChange={e => setFilters(f => ({ ...f, startDate: e.target.value }))} className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-cream" />
          <input type="date" value={filters.endDate} onChange={e => setFilters(f => ({ ...f, endDate: e.target.value }))} className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-cream" />
          <Select value={filters.staffId} onChange={v => setFilters(f => ({ ...f, staffId: v }))} options={[{ label: 'All staff', value: '' }, ...(staffData?.staff ?? []).map(s => ({ label: s.name, value: s.id }))]} />
          <Select value={filters.accountId} onChange={v => setFilters(f => ({ ...f, accountId: v }))} options={[{ label: 'All accounts', value: '' }, ...(accountsData?.accounts ?? []).map(a => ({ label: a.accountTitle, value: a.id }))]} />
          <Select value={filters.status} onChange={v => setFilters(f => ({ ...f, status: v }))} options={[{ label: 'All status', value: 'ALL' }, { label: 'Active', value: 'ACTIVE' }, { label: 'Paused', value: 'PAUSED' }, { label: 'Completed', value: 'COMPLETED' }, { label: 'Closed', value: 'CLOSED' }]} />
          <Select value={filters.profitability} onChange={v => setFilters(f => ({ ...f, profitability: v }))} options={[{ label: 'All P/L', value: 'ALL' }, { label: 'Profitable', value: 'PROFIT' }, { label: 'Loss', value: 'LOSS' }]} />
          <input value={filters.minRoi} onChange={e => setFilters(f => ({ ...f, minRoi: e.target.value }))} placeholder="Min ROI" className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-cream" />
          <input value={filters.maxRoi} onChange={e => setFilters(f => ({ ...f, maxRoi: e.target.value }))} placeholder="Max ROI" className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-cream" />
        </div>
      </Card>

      <div className={KPI_AUTO_GRID}>
        <KpiCard label="Managed capital" value={k?.totalManagedCapital ?? 0} valueKind="currency" color="text-gold-lt" loading={loading} />
        <KpiCard label="Today net" value={k?.todayNet ?? 0} valueKind="currency" color={signedClass(k?.todayNet ?? 0)} loading={loading} />
        <KpiCard label="Weekly net" value={k?.weeklyNet ?? 0} valueKind="currency" color={signedClass(k?.weeklyNet ?? 0)} loading={loading} />
        <KpiCard label="Monthly net" value={k?.monthlyNet ?? 0} valueKind="currency" color={signedClass(k?.monthlyNet ?? 0)} loading={loading} />
        <KpiCard label="USDT volume" value={k?.totalUsdtVolume ?? 0} valueKind="usdt" loading={loading} />
        <KpiCard label="Buy USDT" value={k?.totalBuyUsdt ?? 0} valueKind="usdt" loading={loading} />
        <KpiCard label="Sell USDT" value={k?.totalSellUsdt ?? 0} valueKind="usdt" loading={loading} />
        <KpiCard label="Binance fees" value={k?.totalBinanceFees ?? 0} valueKind="currency" color="text-amber-400" loading={loading} />
        <KpiCard label="Op expenses" value={k?.totalOperatingExpenses ?? 0} valueKind="currency" color="text-red-300" loading={loading} />
        <KpiCard label="Merchants" value={k?.activeMerchantAccounts ?? 0} valueKind="number" loading={loading} />
        <KpiCard label="Staff" value={k?.activeStaffCount ?? 0} valueKind="number" loading={loading} />
      </div>

      {loading ? <Skeleton className="h-52" /> : data?.alerts.length ? (
        <Card className="border-red-400/25 bg-red-400/5 p-4">
          <p className="mb-3 text-sm font-bold text-red-300">Analytics Alerts</p>
          <div className="grid gap-2 md:grid-cols-2">
            {data.alerts.map(alert => (
              <div key={`${alert.type}-${alert.accountId}`} className="rounded-xl border border-red-400/20 bg-black/[0.03] p-3">
                <p className="text-xs font-black text-cream">{alert.type} · {alert.accountTitle}</p>
                <p className="mt-1 text-[11px] text-red-200/70">{alert.message}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <MiniTrendChart title="Profit Trend" data={data?.trend ?? []} valueKey="netBdt" color="#4ade80" />
        <MiniTrendChart title="USDT Volume Trend" data={data?.trend ?? []} valueKey="usdtVolume" color="#d6a94a" />
        <MiniTrendChart title="Expense Trend" data={data?.trend ?? []} valueKey="expenseBdt" color="#f87171" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <RankingBars title="Top Profitable Accounts" rows={data?.topProfitableAccounts ?? []} valueKey="netProfit" valuePrefix="৳" />
        <RankingBars title="Top Loss Accounts" rows={data?.topLossAccounts ?? []} valueKey="netProfit" valuePrefix="৳" />
        <RankingBars title="Best Spread Performance" rows={data?.bestSpreadAccounts ?? []} valueKey="averageSpread" valueSuffix=" BDT" />
        <RankingBars title="Highest Expense Accounts" rows={data?.highestExpenseAccounts ?? []} valueKey="totalExpenses" valuePrefix="৳" />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-center md:justify-between">
          <p className="text-sm font-bold text-cream">Staff Performance Analytics</p>
          <div className="w-full md:w-80"><SearchInput value={search} onChange={setSearch} placeholder="Search report rows..." /></div>
        </div>
        {loading ? <div className="p-4"><Skeleton className="h-40" /></div> : !data?.staff.length ? <Empty icon="◇" title="No staff analytics" /> : (
          <div className="divide-y divide-border">
            {data.staff.map((staff, idx) => (
              <div key={staff.userId} className="grid gap-2 px-4 py-3 text-xs md:grid-cols-[0.3fr_1.2fr_1fr_1fr_1fr_1fr_1fr_1fr]">
                <span className="font-black text-gold-lt">#{idx + 1}</span>
                <span className="font-bold text-cream">{staff.name}</span>
                <span>{staff.activeAccounts}/{staff.assignedAccounts} accounts</span>
                <span>{staff.totalTradedUsdt.toLocaleString('en-BD')} USDT</span>
                <span className="text-green-400">৳{staff.totalProfitGenerated.toLocaleString('en-BD')}</span>
                <span className="text-red-400">৳{staff.totalLossGenerated.toLocaleString('en-BD')}</span>
                <span>{staff.feeEfficiency.toFixed(1)}% fee eff.</span>
                <span className={signedClass(staff.roiContribution)}>{staff.roiContribution.toFixed(2)}% ROI</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.3fr_0.7fr]">
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3"><p className="text-sm font-bold text-cream">Merchant Account Intelligence</p></div>
          {!searchedRows.length ? <Empty icon="◇" title="No account rows" /> : (
            <div className="divide-y divide-border">
              {searchedRows.slice(0, 20).map(row => <AccountIntelRow key={row.id} row={row} />)}
            </div>
          )}
        </Card>
        <Card className="p-4">
          <p className="mb-4 text-sm font-bold text-cream">Expense Intelligence</p>
          {!data?.expenseCategories.length ? <Empty icon="◇" title="No expenses" /> : (
            <div className="space-y-3">
              {data.expenseCategories.slice(0, 8).map(cat => (
                <div key={cat.type}>
                  <div className="mb-1 flex justify-between text-xs"><span className="font-bold text-cream">{cat.type}</span><span className="text-red-300">৳{cat.amount.toLocaleString('en-BD')}</span></div>
                  <div className="h-2 rounded-full bg-border"><div className="h-full rounded-full bg-red-400" style={{ width: `${Math.max(4, (cat.amount / maxExpenseCategory) * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </TradingPageShell>
  )
}

function AccountIntelRow({ row }: { row: TradingAnalyticsAccount }) {
  return (
    <div className="grid gap-2 px-4 py-3 text-xs md:grid-cols-[1.3fr_0.8fr_0.8fr_0.8fr_0.8fr_0.8fr_0.8fr]">
      <div className="min-w-0">
        <p className="truncate font-bold text-cream">{row.accountTitle}</p>
        <p className="mt-0.5 text-[10px] text-zinc-500">{row.assignedUserName}</p>
      </div>
      <span className={`rounded-full border px-2 py-1 text-center text-[10px] font-black ${statusClass(row.status)}`}>{row.status}</span>
      <span className={`font-black ${signedClass(row.netProfit)}`}>৳{row.netProfit.toLocaleString('en-BD')}</span>
      <span>{row.roi.toFixed(2)}% ROI</span>
      <span>{row.averageSpread.toFixed(4)} spread</span>
      <span>{row.feeRatio.toFixed(1)}% fees</span>
      <span className={row.health === 'HEALTHY' ? 'text-green-400' : row.health === 'HIGH_RISK' ? 'text-red-400' : 'text-amber-400'}>{row.health.replace('_', ' ')}</span>
    </div>
  )
}

function reportJson(rows: TradingAnalyticsAccount[]) {
  return rows.map(r => ({
    Account: r.accountTitle,
    Staff: r.assignedUserName,
    Status: r.status,
    Health: r.health,
    'Net Profit BDT': r.netProfit,
    'ROI %': r.roi,
    'USDT Volume': r.totalUsdt,
    'Buy USDT': r.totalBuyUsdt,
    'Sell USDT': r.totalSellUsdt,
    'Buy BDT': r.totalBuyBdt,
    'Sell BDT': r.totalSellBdt,
    'Avg Buy Rate': r.avgBuyRate,
    'Avg Sell Rate': r.avgSellRate,
    'Average Spread': r.averageSpread,
    'Fees BDT': r.totalFees,
    'Expenses BDT': r.totalExpenses,
  }))
}

function toCsv(rows: TradingAnalyticsAccount[]) {
  const json = reportJson(rows)
  const headers = Object.keys(json[0] ?? { Account: '', Staff: '', Status: '', Health: '', 'Net Profit BDT': '', 'ROI %': '' })
  return [headers.join(','), ...json.map(row => headers.map(h => JSON.stringify((row as Record<string, unknown>)[h] ?? '')).join(','))].join('\n')
}

