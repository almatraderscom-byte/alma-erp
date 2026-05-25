import { periodFromDate } from '@/lib/payroll-wallet'
import type { WalletEntryDto } from '@/types/payroll-wallet'

export type SalarySlipBreakdown = {
  periodYm: string
  periodLabel: string
  basicSalary: number
  penalty: number
  netPay: number
  withdrawnInPeriod: number
  isPaid: boolean
}

/** Ledger sources for payouts that cleared (pending wallet requests have no WITHDRAWAL row). */
const APPROVED_WITHDRAWAL_SOURCES = new Set([
  'wallet_request',
  'legacy_hr_payroll',
  'manual_entry',
])

function shiftPeriodYm(periodYm: string, months: number): string {
  const [y, m] = periodYm.split('-').map(Number)
  const d = new Date(y, (m || 1) - 1 + months, 1)
  return periodFromDate(d)
}

export function salarySlipPeriodOptions(now = new Date()) {
  const current = periodFromDate(now)
  return {
    current,
    last: shiftPeriodYm(current, -1),
  }
}

export function formatSalarySlipPeriodLabel(periodYm: string): string {
  const [y, m] = periodYm.split('-').map(Number)
  if (!y || !m) return periodYm
  return new Date(y, m - 1, 1).toLocaleString('en-BD', { month: 'long', year: 'numeric' })
}

function ledgerEntryInPeriod(entry: Pick<WalletEntryDto, 'date' | 'periodYm'>, periodYm: string): boolean {
  if (entry.periodYm === periodYm) return true
  const d = new Date(entry.date)
  if (Number.isNaN(d.getTime())) return false
  return periodFromDate(d) === periodYm
}

function isApprovedWithdrawalEntry(entry: WalletEntryDto): boolean {
  if (entry.type !== 'WITHDRAWAL') return false
  const source = String(entry.source || '').trim().toLowerCase()
  if (!source) return true
  return APPROVED_WITHDRAWAL_SOURCES.has(source)
}

/** Period-scoped basic salary, penalty, and payout status (employee-facing slip). */
export function buildSalarySlipBreakdown(
  entries: WalletEntryDto[],
  periodYm: string,
): SalarySlipBreakdown {
  let basicSalary = 0
  let penalty = 0
  let withdrawnInPeriod = 0

  for (const entry of entries) {
    if (!ledgerEntryInPeriod(entry, periodYm)) continue
    const amount = Math.abs(Number(entry.amount || 0))
    if (!amount) continue
    if (entry.type === 'SALARY_ACCRUAL') {
      basicSalary += amount
    } else if (entry.type === 'PENALTY') {
      penalty += amount
    } else if (isApprovedWithdrawalEntry(entry)) {
      withdrawnInPeriod += amount
    }
  }

  const netPay = basicSalary - penalty

  return {
    periodYm,
    periodLabel: formatSalarySlipPeriodLabel(periodYm),
    basicSalary,
    penalty,
    netPay,
    withdrawnInPeriod,
    isPaid: netPay > 0 && withdrawnInPeriod >= netPay,
  }
}
