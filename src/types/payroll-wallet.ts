import type { EmployeeLedgerEntryType, WalletRequestStatus, WalletRequestType } from '@prisma/client'

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
  totalAdvanceDisbursed: number
  totalAdvanceRecovered: number
  outstandingAdvance: number
  currentBalance: number
  companyLiability: number
  availableWithdrawable: number
  thisMonthSalaryAdded: number
  /** Salary credited for the current cycle (prior calendar month's periodYm). */
  currentCycleSalaryAdded: number
  cyclePeriodYm: string
  entryCount: number
}

export type WalletEntryDto = {
  id?: string
  employeeId?: string
  businessId?: string
  date: string
  periodYm?: string | null
  type: EmployeeLedgerEntryType
  amount: unknown
  note?: string | null
  source?: string | null
  signedAmount: number
  runningBalance: number
}

export type WalletRequestDto = {
  id: string
  userId: string
  employeeId: string
  businessId: string
  type: WalletRequestType
  status: WalletRequestStatus
  requestedAmount: unknown
  approvedAmount?: unknown
  reason: string
  reviewNote?: string | null
  createdAt: string
  reviewedAt?: string | null
}

export type PayrollWallet = {
  employeeId: string
  businessId: string
  name: string
  email?: string
  monthlySalary?: number
  summary: WalletSummary
  latestEntries: WalletEntryDto[]
}

export type WalletSummaryResponse = {
  wallets: PayrollWallet[]
  /** Ledger keys with no GAS roster row and no linked user (audit orphans). */
  orphanLedgerEntryCount?: number
  rosterOnly?: boolean
  totals: {
    companyLiability: number
    lifetimeEarned: number
    lifetimeWithdrawn: number
    currentBalance: number
    totalAccrued: number
    totalCommissions: number
    totalBonuses: number
    totalOvertime: number
    totalReimbursements: number
    totalMealDeductions: number
    totalPenalties: number
  }
  pendingRequests: WalletRequestDto[]
  pendingAdvanceCount: number
  pendingWithdrawalCount: number
}

export type EmployeeWalletResponse = {
  employeeId: string
  businessId: string
  user?: { id: string; profileImageUrl: string | null; updatedAt: string | null } | null
  summary: WalletSummary
  /** True if the staff already dismissed today's outstanding-advance notice (Asia/Dhaka day). */
  advanceNoticeAckedToday?: boolean
  entries: WalletEntryDto[]
  requests: WalletRequestDto[]
}
