import type {
  EmployeeLedgerEntry,
  EmployeeLedgerEntryType,
  WalletRequest,
  WalletRequestStatus,
  WalletRequestType,
} from '@prisma/client'
import { Prisma } from '@prisma/client'
import type { BusinessId } from '@/lib/businesses'
import { parseBusinessAccess } from '@/lib/business-access'
import type { AlmaRole } from '@/lib/roles'
import { normalizeAlmaRole } from '@/lib/roles'

export type WalletEntryLike = Pick<EmployeeLedgerEntry, 'type' | 'amount' | 'date' | 'periodYm'> & {
  id?: string
  note?: string | null
  source?: string | null
  createdAt?: Date
}

export type WalletSummary = {
  employeeId: string
  businessId: string
  lifetimeEarned: number
  lifetimeWithdrawn: number
  totalAccrued: number
  totalBonuses: number
  totalCommissions: number
  totalEidBonuses: number
  totalPerformanceBonuses: number
  totalOvertime: number
  totalReimbursements: number
  totalMealDeductions: number
  totalAdvances: number
  totalWithdrawals: number
  totalPenalties: number
  totalAdjustments: number
  currentBalance: number
  companyLiability: number
  availableWithdrawable: number
  thisMonthSalaryAdded: number
  entryCount: number
}

export type WalletTransaction = WalletEntryLike & {
  signedAmount: number
  runningBalance: number
}

export const WALLET_ADMIN_ROLES: AlmaRole[] = ['SUPER_ADMIN', 'ADMIN', 'HR']

export const WALLET_CREDIT_TYPES: EmployeeLedgerEntryType[] = [
  'SALARY_ACCRUAL',
  'COMMISSION',
  'EID_BONUS',
  'PERFORMANCE_BONUS',
  'OVERTIME',
  'REIMBURSEMENT',
  'MEAL_ALLOWANCE',
  'BONUS',
]

export const WALLET_DEBIT_TYPES: EmployeeLedgerEntryType[] = [
  'ADVANCE',
  'WITHDRAWAL',
  'MEAL_DEDUCTION',
  'PENALTY',
]

export const WALLET_MANUAL_ENTRY_TYPES: EmployeeLedgerEntryType[] = [
  'SALARY_ACCRUAL',
  'ADVANCE',
  'WITHDRAWAL',
  'ADJUSTMENT',
  'COMMISSION',
  'EID_BONUS',
  'PERFORMANCE_BONUS',
  'MEAL_DEDUCTION',
  'OVERTIME',
  'REIMBURSEMENT',
  'PENALTY',
]

export function moneyDecimal(value: unknown): Prisma.Decimal {
  const n = Number(value)
  if (!Number.isFinite(n)) return new Prisma.Decimal(0)
  return new Prisma.Decimal(n.toFixed(2))
}

export function periodFromDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function signedAmount(type: EmployeeLedgerEntryType, amount: unknown): number {
  const n = Number(amount || 0)
  if (WALLET_CREDIT_TYPES.includes(type)) return n
  if (WALLET_DEBIT_TYPES.includes(type)) return -Math.abs(n)
  return n
}

export function runningTransactions(entries: WalletEntryLike[]): WalletTransaction[] {
  let balance = 0
  return [...entries]
    .sort((a, b) => {
      const d = new Date(a.date).getTime() - new Date(b.date).getTime()
      if (d !== 0) return d
      return String(a.id || '').localeCompare(String(b.id || ''))
    })
    .map(entry => {
      balance += signedAmount(entry.type, entry.amount)
      return { ...entry, signedAmount: signedAmount(entry.type, entry.amount), runningBalance: balance }
    })
}

export function computeWalletSummary(
  employeeId: string,
  businessId: string,
  entries: WalletEntryLike[],
  now = new Date(),
): WalletSummary {
  const currentPeriod = periodFromDate(now)
  let totalAccrued = 0
  let totalBonuses = 0
  let totalCommissions = 0
  let totalEidBonuses = 0
  let totalPerformanceBonuses = 0
  let totalOvertime = 0
  let totalReimbursements = 0
  let totalMealDeductions = 0
  let totalAdvances = 0
  let totalWithdrawals = 0
  let totalPenalties = 0
  let totalAdjustments = 0
  let thisMonthSalaryAdded = 0

  for (const e of entries) {
    const amount = Number(e.amount || 0)
    if (e.type === 'SALARY_ACCRUAL') {
      totalAccrued += amount
      if (e.periodYm === currentPeriod) thisMonthSalaryAdded += amount
    } else if (e.type === 'COMMISSION') totalCommissions += amount
    else if (e.type === 'EID_BONUS') totalEidBonuses += amount
    else if (e.type === 'PERFORMANCE_BONUS') totalPerformanceBonuses += amount
    else if (e.type === 'OVERTIME') totalOvertime += amount
    else if (e.type === 'REIMBURSEMENT') totalReimbursements += amount
    else if (e.type === 'MEAL_ALLOWANCE') totalReimbursements += amount
    else if (e.type === 'MEAL_DEDUCTION') totalMealDeductions += Math.abs(amount)
    else if (e.type === 'BONUS') totalBonuses += amount
    else if (e.type === 'ADVANCE') totalAdvances += Math.abs(amount)
    else if (e.type === 'WITHDRAWAL') totalWithdrawals += Math.abs(amount)
    else if (e.type === 'PENALTY') totalPenalties += Math.abs(amount)
    else if (e.type === 'ADJUSTMENT') totalAdjustments += amount
  }

  totalBonuses += totalEidBonuses + totalPerformanceBonuses
  const lifetimeEarned = totalAccrued + totalBonuses + totalCommissions + totalOvertime + totalReimbursements
  const lifetimeWithdrawn = totalAdvances + totalWithdrawals + totalPenalties + totalMealDeductions
  const currentBalance = lifetimeEarned - lifetimeWithdrawn + totalAdjustments

  return {
    employeeId,
    businessId,
    lifetimeEarned,
    lifetimeWithdrawn,
    totalAccrued,
    totalBonuses,
    totalCommissions,
    totalEidBonuses,
    totalPerformanceBonuses,
    totalOvertime,
    totalReimbursements,
    totalMealDeductions,
    totalAdvances,
    totalWithdrawals,
    totalPenalties,
    totalAdjustments,
    currentBalance,
    companyLiability: Math.max(0, currentBalance),
    availableWithdrawable: Math.max(0, currentBalance),
    thisMonthSalaryAdded,
    entryCount: entries.length,
  }
}

export function isWalletAdmin(role: unknown): boolean {
  return WALLET_ADMIN_ROLES.includes(normalizeAlmaRole(String(role)) as AlmaRole)
}

export function walletBusinessFilter(raw: unknown, requested?: string | null): BusinessId[] {
  const allowed = parseBusinessAccess(String(raw || ''))
  if (requested && allowed.includes(requested as BusinessId)) return [requested as BusinessId]
  return allowed
}

export function requestStatusFromApproval(
  requestedAmount: number,
  approvedAmount: number,
  rejected = false,
): WalletRequestStatus {
  if (rejected) return 'REJECTED'
  return approvedAmount >= requestedAmount ? 'APPROVED' : 'PARTIALLY_APPROVED'
}

export function entryTypeForRequest(type: WalletRequestType): EmployeeLedgerEntryType {
  return type === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'ADVANCE'
}

export function isDebitCompensationType(type: EmployeeLedgerEntryType): boolean {
  return ['MEAL_DEDUCTION', 'PENALTY', 'ADVANCE', 'WITHDRAWAL'].includes(type)
}

export function compensationTitle(type: EmployeeLedgerEntryType): string {
  if (type === 'COMMISSION') return 'Commission added'
  if (type === 'EID_BONUS') return 'Eid bonus added'
  if (type === 'PERFORMANCE_BONUS') return 'Performance bonus added'
  if (type === 'OVERTIME') return 'Overtime approved'
  if (type === 'REIMBURSEMENT') return 'Reimbursement added'
  if (type === 'MEAL_ALLOWANCE') return 'Meal allowance'
  if (type === 'MEAL_DEDUCTION') return 'Meal deduction added'
  if (type === 'PENALTY') return 'Penalty added'
  if (type === 'WITHDRAWAL') return 'Payout processed'
  return 'Wallet ledger updated'
}

export type WalletRequestDto = WalletRequest & {
  requester?: { name: string; email: string }
}
