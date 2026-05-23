'use client'

import { useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { TradingPageShell } from '@/components/trading/TradingPageShell'
import { Button, Card, Empty, KpiCard, Money, Skeleton } from '@/components/ui'
import { EmployeeAvatar } from '@/components/profile/EmployeeAvatar'
import { useSaveTradingHrProfile, useSubmitTradingEmployeeReport, useTradingHr } from '@/hooks/useTrading'
import { signedClass } from '@/components/trading/trading-utils'
import type { TradingHrEmployee } from '@/types/trading'

export default function TradingHrPage() {
  const { data, loading, refetch } = useTradingHr()
  const { mutate: saveProfile, loading: savingProfile } = useSaveTradingHrProfile()
  const { mutate: submitReport, loading: submittingReport } = useSubmitTradingEmployeeReport()
  const [profileEmployee, setProfileEmployee] = useState<TradingHrEmployee | null>(null)
  const [reportEmployee, setReportEmployee] = useState<TradingHrEmployee | null>(null)
  const profileFormRef = useRef<HTMLFormElement>(null)
  const reportFormRef = useRef<HTMLFormElement>(null)

  const employees = data?.employees ?? []
  const rankings = useMemo(() => data?.rankings, [data?.rankings])

  async function onProfileSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!profileEmployee) return
    const fd = new FormData(e.currentTarget)
    const res = await saveProfile({
      userId: profileEmployee.user.id,
      employeeIdGas: String(fd.get('employeeIdGas') || ''),
      roleTitle: String(fd.get('roleTitle') || ''),
      shift: String(fd.get('shift') || 'DAY'),
      status: String(fd.get('status') || 'ACTIVE'),
      salary: Number(fd.get('salary') || 0),
      commissionType: String(fd.get('commissionType') || 'NONE') as 'NONE' | 'PERCENTAGE' | 'FIXED',
      commissionRate: Number(fd.get('commissionRate') || 0),
      fixedCommission: Number(fd.get('fixedCommission') || 0),
      merchantCompletionBonus: Number(fd.get('merchantCompletionBonus') || 0),
      milestoneBonus: Number(fd.get('milestoneBonus') || 0),
      joiningDate: String(fd.get('joiningDate') || ''),
      notes: String(fd.get('notes') || ''),
    })
    if (!res) return
    toast.success('Trading employee profile saved')
    setProfileEmployee(null)
    refetch()
  }

  async function onReportSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!reportEmployee) return
    const fd = new FormData(e.currentTarget)
    const res = await submitReport({
      userId: reportEmployee.user.id,
      reportDate: String(fd.get('reportDate') || new Date().toISOString().slice(0, 10)),
      accountIds: String(fd.get('accountIds') || '').split(',').map(v => v.trim()).filter(Boolean),
      totalTrades: Number(fd.get('totalTrades') || 0),
      dailyProfitBdt: Number(fd.get('dailyProfitBdt') || 0),
      dailyLossBdt: Number(fd.get('dailyLossBdt') || 0),
      issues: String(fd.get('issues') || ''),
      screenshotProof: String(fd.get('screenshotProof') || ''),
      operationalNotes: String(fd.get('operationalNotes') || ''),
    })
    if (!res) return
    toast.success('Daily employee report submitted')
    setReportEmployee(null)
    refetch()
  }

  return (
    <TradingPageShell
      title="Trading HR"
      subtitle="Employee profiles, payroll wallets, activity reports, and staff performance intelligence"
    >
      <div className="min-w-0 max-w-full space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiCard label="Employees" value={data?.kpis.totalEmployees ?? 0} loading={loading} />
        <KpiCard label="Active staff" value={data?.kpis.activeEmployees ?? 0} loading={loading} />
        <KpiCard label="Managed accounts" value={data?.kpis.totalManagedAccounts ?? 0} loading={loading} />
        <KpiCard label="Profit generated" value={data?.kpis.totalProfitGenerated ?? 0} color="text-green-400" loading={loading} />
        <KpiCard label="Losses" value={data?.kpis.totalLosses ?? 0} color="text-red-400" loading={loading} />
        <KpiCard label="Commissions" value={data?.kpis.totalCommissions ?? 0} color="text-gold-lt" loading={loading} />
        <KpiCard label="Wallet balance" value={data?.kpis.totalWalletBalance ?? 0} color="text-blue-300" loading={loading} />
        <KpiCard label="Missing reports" value={data?.kpis.missingReports ?? 0} color="text-amber-300" loading={loading} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="min-w-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-bold text-cream">Trading Employee Profiles</p>
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Business scoped</span>
          </div>
          {loading ? <div className="p-4"><Skeleton className="h-56" /></div> : !employees.length ? <Empty icon="☷" title="No trading employees yet" /> : (
            <div className="overflow-x-auto min-w-0 max-w-full">
              <div className="min-w-[1120px] divide-y divide-border">
                <div className="grid grid-cols-[1.2fr_0.8fr_1fr_0.8fr_0.8fr_0.8fr_0.8fr_1fr] gap-3 px-4 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-zinc-600">
                  <span>Employee</span><span>Shift</span><span>Accounts</span><span>Trades</span><span>Net P/L</span><span>Wallet</span><span>Consistency</span><span>Actions</span>
                </div>
                {employees.map(employee => (
                  <div key={employee.user.id} className="grid grid-cols-[1.2fr_0.8fr_1fr_0.8fr_0.8fr_0.8fr_0.8fr_1fr] gap-3 px-4 py-3 text-xs">
                    <span className="flex items-center gap-2">
                      <EmployeeAvatar
                        userId={employee.user.id}
                        name={employee.user.name}
                        email={employee.user.email}
                        imageUrl={employee.user.profileImageUrl}
                        size="sm"
                      />
                      <span>
                        <b className="text-cream">{employee.user.name}</b>
                        <br />
                        <span className="text-[10px] text-zinc-500">{employee.profile?.roleTitle || employee.user.role} · {employee.user.employeeIdGas || 'No employee link'}</span>
                      </span>
                    </span>
                    <span className="text-zinc-400">{employee.profile?.shift || 'DAY'}</span>
                    <span className="text-zinc-400">{employee.metrics.totalAccountsManaged} total · {employee.metrics.activeAccounts} active</span>
                    <span className="text-gold-lt">{employee.metrics.totalTrades.toLocaleString('en-BD')}</span>
                    <span className={signedClass(employee.metrics.netResult)}><Money amount={employee.metrics.netResult} /></span>
                    <span className="text-blue-300"><Money amount={employee.wallet?.currentBalance ?? 0} /></span>
                    <span className="text-zinc-400">{employee.metrics.activityConsistency.toFixed(0)}%</span>
                    <span className="flex flex-wrap gap-1">
                      <Button size="xs" variant="secondary" onClick={() => setProfileEmployee(employee)}>Profile</Button>
                      <Button size="xs" variant="ghost" onClick={() => setReportEmployee(employee)}>Report</Button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <p className="text-sm font-bold text-cream">HR Alert Engine</p>
          </div>
          {!data?.alerts.length ? <Empty icon="◇" title="No HR alerts" /> : (
            <div className="divide-y divide-border">
              {data.alerts.slice(0, 10).map((alert, idx) => (
                <div key={`${alert.userId}-${alert.type}-${idx}`} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-black text-cream">{alert.title}</p>
                      <p className="mt-1 text-[11px] text-zinc-500">{alert.message}</p>
                    </div>
                    <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] font-black text-amber-300">{alert.severity}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <RankingCard title="Top Trader" rows={rankings?.topTrader ?? []} metric={e => `${e.metrics.totalTrades} trades`} />
        <RankingCard title="Most Profitable" rows={rankings?.mostProfitable ?? []} metric={e => `৳${e.metrics.netResult.toLocaleString('en-BD')}`} />
        <RankingCard title="Lowest Loss Ratio" rows={rankings?.lowestLossRatio ?? []} metric={e => `Loss ৳${e.metrics.totalLosses.toLocaleString('en-BD')}`} />
        <RankingCard title="Merchant Growth" rows={rankings?.bestMerchantGrowth ?? []} metric={e => `${e.metrics.merchantGrowthSuccess.toFixed(0)}%`} />
        <RankingCard title="Most Active" rows={rankings?.mostActive ?? []} metric={e => `${e.metrics.activityConsistency.toFixed(0)}%`} />
      </div>
      </div>

      {profileEmployee && (
        <MobileModalPortal
          open
          zIndex={120}
          onBackdropClick={() => setProfileEmployee(null)}
          aria-label={`Trading profile · ${profileEmployee.user.name}`}
        >
          <Card className="mobile-modal-shell w-full max-w-3xl border-gold-dim/30 sm:rounded-2xl">
            <div className="mobile-modal-header flex items-center justify-between gap-3 p-5 pb-3">
              <p className="text-sm font-bold text-cream">Trading profile · {profileEmployee.user.name}</p>
              <Button type="button" size="xs" variant="ghost" onClick={() => setProfileEmployee(null)}>Close</Button>
            </div>
            <form ref={profileFormRef} id="trading-hr-profile-form" onSubmit={onProfileSubmit} className="flex min-h-0 flex-1 flex-col text-xs">
              <div className="mobile-modal-body space-y-3 px-5 pb-4">
            <div className="grid grid-cols-2 gap-2">
              <Field name="employeeIdGas" label="Employee ID" defaultValue={profileEmployee.profile?.employeeIdGas || profileEmployee.user.employeeIdGas || ''} />
              <Field name="roleTitle" label="Trading role" defaultValue={profileEmployee.profile?.roleTitle || ''} />
              <label className="space-y-1">
                <span className="text-[10px] font-bold uppercase text-zinc-500">Shift</span>
                <select name="shift" defaultValue={profileEmployee.profile?.shift || 'DAY'} className="w-full rounded-xl border border-border bg-black/25 px-3 py-2 text-cream">
                  <option value="DAY">Day shift</option>
                  <option value="NIGHT">Night shift</option>
                </select>
              </label>
              <Field name="status" label="Status" defaultValue={profileEmployee.profile?.status || 'ACTIVE'} />
              <Field name="joiningDate" label="Joining date" type="date" defaultValue={profileEmployee.user.joiningDate ? String(profileEmployee.user.joiningDate).slice(0, 10) : ''} />
              <Field name="salary" label="Salary" type="number" defaultValue={String(profileEmployee.profile?.salary || profileEmployee.user.salaryHint || 0)} />
              <label className="space-y-1">
                <span className="text-[10px] font-bold uppercase text-zinc-500">Commission type</span>
                <select name="commissionType" defaultValue={profileEmployee.profile?.commissionType || 'NONE'} className="w-full rounded-xl border border-border bg-black/25 px-3 py-2 text-cream">
                  <option value="NONE">None</option>
                  <option value="PERCENTAGE">Profit percentage</option>
                  <option value="FIXED">Fixed bonus</option>
                </select>
              </label>
              <Field name="commissionRate" label="Commission rate %" type="number" defaultValue={String(profileEmployee.profile?.commissionRate || 0)} />
              <Field name="fixedCommission" label="Fixed commission" type="number" defaultValue={String(profileEmployee.profile?.fixedCommission || 0)} />
              <Field name="merchantCompletionBonus" label="Completion bonus" type="number" defaultValue={String(profileEmployee.profile?.merchantCompletionBonus || 0)} />
              <Field name="milestoneBonus" label="Milestone bonus" type="number" defaultValue={String(profileEmployee.profile?.milestoneBonus || 0)} />
            </div>
            <Textarea name="notes" label="Notes" defaultValue={profileEmployee.profile?.notes || ''} />
              </div>
              <div className="mobile-modal-footer px-5 pt-3">
                <Button
                  type="button"
                  variant="gold"
                  className="w-full justify-center"
                  disabled={savingProfile}
                  onClick={() => profileFormRef.current?.requestSubmit()}
                >
                  {savingProfile ? 'Saving...' : 'Save profile'}
                </Button>
              </div>
            </form>
          </Card>
        </MobileModalPortal>
      )}

      {reportEmployee && (
        <MobileModalPortal
          open
          zIndex={120}
          onBackdropClick={() => setReportEmployee(null)}
          aria-label={`Daily report · ${reportEmployee.user.name}`}
        >
          <Card className="mobile-modal-shell w-full max-w-3xl border-gold-dim/30 sm:rounded-2xl">
            <div className="mobile-modal-header flex items-center justify-between gap-3 p-5 pb-3">
              <p className="text-sm font-bold text-cream">Daily report · {reportEmployee.user.name}</p>
              <Button type="button" size="xs" variant="ghost" onClick={() => setReportEmployee(null)}>Close</Button>
            </div>
            <form ref={reportFormRef} id="trading-hr-report-form" onSubmit={onReportSubmit} className="flex min-h-0 flex-1 flex-col text-xs">
              <div className="mobile-modal-body space-y-3 px-5 pb-4">
            <Field name="reportDate" label="Report date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
            <Field name="accountIds" label="Accounts worked on" defaultValue={reportEmployee.assignedAccounts.map(a => a.id).join(',')} />
            <div className="grid grid-cols-3 gap-2">
              <Field name="totalTrades" label="Total trades" type="number" defaultValue="0" />
              <Field name="dailyProfitBdt" label="Daily profit" type="number" defaultValue="0" />
              <Field name="dailyLossBdt" label="Daily loss" type="number" defaultValue="0" />
            </div>
            <Field name="screenshotProof" label="Screenshot proof URL" />
            <Textarea name="issues" label="Issues / problems" />
            <Textarea name="operationalNotes" label="Operational notes" />
              </div>
              <div className="mobile-modal-footer px-5 pt-3">
                <Button
                  type="button"
                  variant="gold"
                  className="w-full justify-center"
                  disabled={submittingReport}
                  onClick={() => reportFormRef.current?.requestSubmit()}
                >
                  {submittingReport ? 'Submitting...' : 'Submit report'}
                </Button>
              </div>
            </form>
          </Card>
        </MobileModalPortal>
      )}
    </TradingPageShell>
  )
}

function RankingCard({ title, rows, metric }: { title: string; rows: TradingHrEmployee[]; metric: (row: TradingHrEmployee) => string }) {
  return (
    <Card className="p-4">
      <p className="text-sm font-bold text-cream">{title}</p>
      <div className="mt-3 space-y-2">
        {!rows.length ? <p className="text-[11px] text-zinc-500">No data yet</p> : rows.slice(0, 5).map((row, index) => (
          <div key={row.user.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-zinc-300">{index + 1}. {row.user.name}</span>
            <span className="font-mono text-gold-lt">{metric(row)}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function Field({ name, label, type = 'text', defaultValue = '' }: { name: string; label: string; type?: string; defaultValue?: string }) {
  return (
    <label className="space-y-1">
      <span className="text-[10px] font-bold uppercase text-zinc-500">{label}</span>
      <input name={name} type={type} defaultValue={defaultValue} className="w-full rounded-xl border border-border bg-black/25 px-3 py-2 text-cream" />
    </label>
  )
}

function Textarea({ name, label, defaultValue = '' }: { name: string; label: string; defaultValue?: string }) {
  return (
    <label className="space-y-1">
      <span className="text-[10px] font-bold uppercase text-zinc-500">{label}</span>
      <textarea name={name} defaultValue={defaultValue} rows={3} className="w-full rounded-xl border border-border bg-black/25 px-3 py-2 text-cream" />
    </label>
  )
}
