import type { EmployeeLedgerEntryType } from '@prisma/client'
import { periodFromDate, signedAmount } from '@/lib/payroll-wallet'
import type { WalletEntryDto } from '@/types/payroll-wallet'

export type SalarySlipLine = { label: string; amount: number }

export type SalarySlipBreakdown = {
  periodYm: string
  periodLabel: string
  earnings: SalarySlipLine[]
  deductions: SalarySlipLine[]
  totalEarnings: number
  totalDeductions: number
  netPay: number
}

const EARNING_LINE_ORDER = [
  'Basic Salary',
  'Commission',
  'Bonus',
  'Overtime',
  'Reimbursement',
  'Meal Allowance',
  'Adjustment',
] as const

const DEDUCTION_LINE_ORDER = [
  'Late attendance penalty',
  'Meal deduction',
  'Salary advance',
  'Withdrawal',
  'Commission reversal',
  'Adjustment',
] as const

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

function earningLineLabel(type: EmployeeLedgerEntryType): string {
  if (type === 'SALARY_ACCRUAL') return 'Basic Salary'
  if (type === 'COMMISSION') return 'Commission'
  if (type === 'EID_BONUS' || type === 'PERFORMANCE_BONUS' || type === 'BONUS') return 'Bonus'
  if (type === 'OVERTIME') return 'Overtime'
  if (type === 'REIMBURSEMENT') return 'Reimbursement'
  if (type === 'MEAL_ALLOWANCE') return 'Meal Allowance'
  if (type === 'ADJUSTMENT') return 'Adjustment'
  return type.replace(/_/g, ' ')
}

function deductionLineLabel(type: EmployeeLedgerEntryType): string {
  if (type === 'PENALTY') return 'Late attendance penalty'
  if (type === 'MEAL_DEDUCTION') return 'Meal deduction'
  if (type === 'ADVANCE') return 'Salary advance'
  if (type === 'WITHDRAWAL') return 'Withdrawal'
  if (type === 'COMMISSION') return 'Commission reversal'
  if (type === 'ADJUSTMENT') return 'Adjustment'
  return type.replace(/_/g, ' ')
}

function sortLines(map: Map<string, number>, order: readonly string[]): SalarySlipLine[] {
  const lines = [...map.entries()]
    .filter(([, amount]) => amount > 0)
    .map(([label, amount]) => ({ label, amount }))
  return lines.sort((a, b) => {
    const ai = order.indexOf(a.label as (typeof order)[number])
    const bi = order.indexOf(b.label as (typeof order)[number])
    if (ai === -1 && bi === -1) return a.label.localeCompare(b.label)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

/** Period-scoped earnings/deductions for employee salary slip PDF (Postgres wallet ledger). */
export function buildSalarySlipBreakdown(
  entries: WalletEntryDto[],
  periodYm: string,
): SalarySlipBreakdown {
  const earningsMap = new Map<string, number>()
  const deductionsMap = new Map<string, number>()

  for (const entry of entries) {
    if (!ledgerEntryInPeriod(entry, periodYm)) continue
    const signed = signedAmount(entry.type, entry.amount)
    const abs = Math.abs(signed)
    if (!abs) continue
    if (signed > 0) {
      const label = earningLineLabel(entry.type)
      earningsMap.set(label, (earningsMap.get(label) || 0) + abs)
    } else {
      const label = deductionLineLabel(entry.type)
      deductionsMap.set(label, (deductionsMap.get(label) || 0) + abs)
    }
  }

  const earnings = sortLines(earningsMap, EARNING_LINE_ORDER)
  const deductions = sortLines(deductionsMap, DEDUCTION_LINE_ORDER)
  const totalEarnings = earnings.reduce((sum, line) => sum + line.amount, 0)
  const totalDeductions = deductions.reduce((sum, line) => sum + line.amount, 0)

  return {
    periodYm,
    periodLabel: formatSalarySlipPeriodLabel(periodYm),
    earnings,
    deductions,
    totalEarnings,
    totalDeductions,
    netPay: totalEarnings - totalDeductions,
  }
}
