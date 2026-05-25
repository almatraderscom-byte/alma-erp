'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Card, Skeleton } from '@/components/ui'
import { SalarySlipToolbar } from '@/components/finance/SalarySlipToolbar'
import type { SalarySlipModel } from '@/components/pdf/SalarySlipDocument'
import { useBranding } from '@/contexts/BrandingContext'
import { useBusiness } from '@/contexts/BusinessContext'
import {
  buildSalarySlipBreakdown,
  formatSalarySlipPeriodLabel,
  salarySlipPeriodOptions,
} from '@/lib/salary-slip'
import type { DeskProfile } from '@/hooks/useMyDeskProfile'
import type { EmployeeWalletResponse } from '@/types/payroll-wallet'
import type { HREmployee } from '@/types/hr'

type MySalarySlipCardProps = {
  empLinked: boolean
  employeeId: string | null
  profile: DeskProfile | null
  sessionRole: string
  wallet: EmployeeWalletResponse | null
  walletLoading: boolean
}

export function MySalarySlipCard({
  empLinked,
  employeeId,
  profile,
  sessionRole,
  wallet,
  walletLoading,
}: MySalarySlipCardProps) {
  const { business } = useBusiness()
  const { branding } = useBranding()
  const slipPeriodOptions = useMemo(() => salarySlipPeriodOptions(), [])
  const [slipPeriodYm, setSlipPeriodYm] = useState(() => slipPeriodOptions.current)

  const slipBreakdown = useMemo(
    () => buildSalarySlipBreakdown(wallet?.entries ?? [], slipPeriodYm),
    [wallet?.entries, slipPeriodYm],
  )

  const slipEmployee: HREmployee | null = empLinked && employeeId && profile
    ? {
        emp_id: employeeId,
        business_id: business.id,
        name: profile.name,
        phone: profile.phone || '',
        email: profile.email,
        address: '',
        role: profile.profile?.roleTitle || sessionRole.replace(/_/g, ' '),
        joining_date: profile.joiningDate || '',
        monthly_salary: Number(profile.salaryHint ?? profile.profile?.salary ?? 0),
        status: profile.profile?.status || 'active',
        notes: '',
      }
    : null

  const slipModel: SalarySlipModel | null = slipEmployee
    ? {
        companyName: branding?.company_name ?? business.name,
        tagline: branding?.tagline ?? business.tagline,
        logoUrl: branding?.logo_url || null,
        employee: slipEmployee,
        periodLabel: formatSalarySlipPeriodLabel(slipPeriodYm),
        breakdown: slipBreakdown,
        generatedAt: new Date().toISOString().slice(0, 10),
      }
    : null

  return (
    <Card className="p-5 border-gold-dim/25 bg-[#0c0c10] space-y-4">
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">My salary slip</p>
        <p className="mt-1 text-[11px] text-zinc-500">Download your monthly salary statement</p>
      </div>

      {!empLinked ? (
        <div className="rounded-xl border border-amber-300/25 bg-amber-300/5 px-4 py-3 text-[11px] text-amber-100">
          <p>Link your HR employee ID to view salary slips.</p>
          <p className="mt-2 text-zinc-500">Ask an admin or HR to link your account in Users settings.</p>
          <Link
            href="/settings/session"
            className="mt-3 inline-block text-[11px] font-semibold text-gold-lt underline"
          >
            Account settings
          </Link>
        </div>
      ) : walletLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] text-zinc-500 flex items-center gap-1.5">
              Period
              <select
                value={slipPeriodYm}
                onChange={e => setSlipPeriodYm(e.target.value)}
                className="rounded-lg border border-border bg-black/30 px-2 py-1 text-[11px] text-cream"
              >
                <option value={slipPeriodOptions.current}>
                  This month ({formatSalarySlipPeriodLabel(slipPeriodOptions.current)})
                </option>
                <option value={slipPeriodOptions.last}>
                  Last month ({formatSalarySlipPeriodLabel(slipPeriodOptions.last)})
                </option>
              </select>
            </label>
            <input
              type="month"
              value={slipPeriodYm}
              onChange={e => setSlipPeriodYm(e.target.value || slipPeriodOptions.current)}
              className="rounded-lg border border-border bg-black/30 px-2 py-1 text-[11px] font-mono text-cream"
              aria-label="Custom slip period"
            />
          </div>

          <div className="rounded-xl border border-border bg-black/25 px-4 py-3 space-y-2 text-[11px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-zinc-500">Period</span>
              <span className="font-medium text-cream">{slipBreakdown.periodLabel}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-zinc-500">Basic salary</span>
              <span className="font-mono text-cream">৳ {slipBreakdown.basicSalary.toLocaleString('en-BD')}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-zinc-500">Penalty</span>
              <span className="font-mono text-red-300">৳ {slipBreakdown.penalty.toLocaleString('en-BD')}</span>
            </div>
            <div className="flex justify-between gap-3 border-t border-border pt-2">
              <span className="font-semibold text-cream">Net pay</span>
              <span className="font-mono font-bold text-gold-lt">৳ {slipBreakdown.netPay.toLocaleString('en-BD')}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span className="text-zinc-500">Status</span>
              {slipBreakdown.isPaid ? (
                <span className="inline-flex items-center gap-1 rounded-lg border border-green-400/35 bg-green-400/10 px-2 py-0.5 text-[10px] font-bold uppercase text-green-300">
                  <span aria-hidden>🟢</span> PAID
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-lg border border-red-400/35 bg-red-400/10 px-2 py-0.5 text-[10px] font-bold uppercase text-red-300">
                  <span aria-hidden>🔴</span> UNPAID
                </span>
              )}
            </div>
          </div>

          {slipModel ? (
            <div className="flex flex-wrap justify-end">
              <SalarySlipToolbar model={slipModel} />
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}
