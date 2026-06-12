export type TradingAccountStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CLOSED'
export type TradingAccountType = 'BINANCE_P2P' | 'MERCHANT' | 'STAFF_OPERATED' | 'OTHER'
export type TradingCapitalEntryType = 'DEPOSIT' | 'WITHDRAW' | 'ADJUSTMENT'
export type TradingTradeType = 'BUY' | 'SELL'
export type TradingCommissionType = 'NONE' | 'PERCENTAGE' | 'FIXED'
export type TradingExpensePaidBy = 'OWNER' | 'STAFF'

export type TradingUser = {
  id: string
  name: string
  email?: string | null
  phone?: string | null
  role?: string
  employeeIdGas?: string | null
  salaryHint?: number | string | null
  profileImageUrl?: string | null
}

export type TradingAccount = {
  id: string
  businessId: 'ALMA_TRADING'
  assignedUserId?: string | null
  assignedUser?: TradingUser | null
  accountTitle: string
  binanceUid?: string | null
  accountType: TradingAccountType
  status: TradingAccountStatus
  startingCapital: number | string
  currentBalance: number | string
  totalProfit: number | string
  totalLoss: number | string
  totalFees: number | string
  totalExpenses: number | string
  totalWithdrawals: number | string
  netRoi: number | string
  totalBuyUsdt: number | string
  totalSellUsdt: number | string
  totalBuyBdt: number | string
  totalSellBdt: number | string
  usdtBalance: number | string
  inventoryCostBdt: number | string
  commissionType: TradingCommissionType
  commissionRate: number | string
  fixedCommission: number | string
  completionBonus: number | string
  merchantTarget?: number | string | null
  merchantProgress: number | string
  partnershipEnabled?: boolean
  staffSharePercent?: number | string
  lastPartnershipSettledAt?: string | null
  startDate: string
  completedDate?: string | null
  notes?: string | null
  createdAt: string
  updatedAt: string
}

export type TradingTrade = {
  id: string
  tradingAccountId: string
  userId: string
  businessId: 'ALMA_TRADING'
  tradeType: TradingTradeType
  buyAmount: number | string
  sellAmount: number | string
  usdtAmount: number | string
  bdtRate: number | string
  buyRateBdt: number | string
  sellRateBdt: number | string
  totalBdt: number | string
  netBdt: number | string
  costBasisBdt: number | string
  feeUsdt: number | string
  feeBdt: number | string
  feeAmount: number | string
  netProfit: number | string
  tradeDate: string
  notes?: string | null
  deletedAt?: string | null
  deletedBy?: string | null
  deleteReason?: string | null
  deleteApprovedBy?: string | null
  deleteApprovedAt?: string | null
  editHistory?: TradingTradeAuditEntry[] | null
  updatedBy?: string | null
  createdAt: string
  tradingAccount?: { accountTitle: string }
  user?: { name: string }
}

export type TradingTradeAuditEntry = {
  action: 'EDITED' | 'DELETE_REQUESTED' | 'DELETE_APPROVED' | 'DELETE_REJECTED'
  actorUserId: string
  actorRole: string
  reason: string
  timestamp: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}

export type TradingExpense = {
  id: string
  tradingAccountId: string
  businessId: 'ALMA_TRADING'
  expenseType: string
  amount: number | string
  paidBy?: TradingExpensePaidBy | null
  settlementId?: string | null
  notes?: string | null
  attachmentUrl?: string | null
  expenseDate: string
  createdBy: string
  createdAt: string
  tradingAccount?: { accountTitle: string }
  creator?: { name: string }
}

export type TradingPartnershipSettlement = {
  id: string
  tradingAccountId: string
  periodStart: string
  periodEnd: string
  deltaProfitBdt: number | string
  deltaLossBdt: number | string
  netTradingDeltaBdt: number | string
  ownerPaidExpensesBdt: number | string
  staffPaidExpensesBdt: number | string
  staffSharePercent: number | string
  staffTradingShareBdt: number | string
  expenseAdjustmentBdt: number | string
  netStaffOwesBdt: number | string
  adminOverrideBdt?: number | string | null
  notes?: string | null
  ledgerEntryId?: string | null
  settledByUserId: string
  createdAt: string
  settledBy?: { id?: string; name: string } | null
}

export type TradingPartnershipPreview = {
  partnershipEnabled: boolean
  staffSharePercent: number
  periodStart: string | null
  periodEnd: string
  deltaProfitBdt: number
  deltaLossBdt: number
  netTradingDeltaBdt: number
  ownerPaidExpensesBdt: number
  staffPaidExpensesBdt: number
  staffTradingShareBdt: number
  expenseAdjustmentBdt: number
  netStaffOwesBdt: number
  unsettledExpenses: TradingExpense[]
}

export type TradingPartnershipResponse = {
  ok: boolean
  preview: TradingPartnershipPreview
  history: TradingPartnershipSettlement[]
}

export type TradingCapitalEntry = {
  id: string
  tradingAccountId: string
  businessId: 'ALMA_TRADING'
  entryType: TradingCapitalEntryType
  amount: number | string
  notes?: string | null
  createdBy: string
  createdAt: string
  tradingAccount?: { accountTitle: string }
  creator?: { name: string }
}

export type TradingSummary = {
  accountId: string
  businessId: 'ALMA_TRADING'
  startingCapital: number
  currentBalance: number
  totalProfit: number
  totalLoss: number
  totalFees: number
  totalExpenses: number
  totalWithdrawals: number
  totalTrades: number
  totalTradedUsdt: number
  totalBuyUsdt: number
  totalSellUsdt: number
  totalBuyBdt: number
  totalSellBdt: number
  usdtBalance: number
  inventoryCostBdt: number
  averageBuyRate: number
  averageSellRate: number
  averageSpread: number
  netTradingProfit: number
  netOperationalProfit: number
  roiPct: number
  deposits: number
  withdrawals: number
  adjustments: number
  merchantTarget: number | null
  merchantProgress: number
}

export type TradingDailySummary = {
  tradesCount: number
  bkashOrders: number
  usdtVolume: number
  buyUsdtVolume: number
  sellUsdtVolume: number
  buyBdtVolume: number
  sellBdtVolume: number
  profit: number
  loss: number
  bkashProfit: number
  bkashLoss: number
  fees: number
  expenses: number
  netResult: number
}

export type TradingRangeSummary = {
  tradesCount: number
  bkashOrders?: number
  usdtVolume: number
  buyUsdtVolume?: number
  sellUsdtVolume?: number
  buyBdtVolume?: number
  sellBdtVolume?: number
  grossProfitBdt?: number
  grossLossBdt?: number
  feeBdt?: number
  expenseBdt?: number
  netResultBdt?: number
  profit?: number
  loss?: number
  bkashProfit?: number
  bkashLoss?: number
  fees?: number
  expenses?: number
  netResult?: number
}

export type TradingBusinessSummaryResponse = {
  kpis: {
    activeAccounts: number
    totalCapital: number
    totalProfit: number
    totalLoss: number
    totalFees: number
    totalOperatingExpenses: number
    dailyNetBdt: number
    monthlyNetBdt: number
    totalTradedUsdt: number
    totalBuyUsdt: number
    totalSellUsdt: number
    currentMonthStart: string
  }
  ranges: {
    today: TradingRangeSummary
    yesterday: TradingRangeSummary
    last7: TradingRangeSummary
    currentMonth: TradingRangeSummary
  }
}

export type TradingStaffSummaryResponse = {
  staff: Array<{
    userId: string
    name: string
    email?: string | null
    assignedAccounts: number
    activeAccounts: number
    totalManagedCapital: number
    totalTradedUsdt: number
    totalAccountProfit: number
    totalAccountLoss: number
    commissionEarned: number
    salaryEarned: number
    withdrawableBalance: number
    monthlyNetResult: number
  }>
}

export type TradingEmployeeProfile = {
  id: string
  businessId: 'ALMA_TRADING'
  userId: string
  employeeIdGas?: string | null
  roleTitle?: string | null
  shift: 'DAY' | 'NIGHT' | string
  status: string
  salary: number | string
  commissionType: TradingCommissionType
  commissionRate: number | string
  fixedCommission: number | string
  merchantCompletionBonus: number | string
  milestoneBonus: number | string
  notes?: string | null
  lastActiveAt?: string | null
  createdAt: string
  updatedAt: string
}

export type TradingEmployeeDailyReport = {
  id: string
  businessId: 'ALMA_TRADING'
  userId: string
  reportDate: string
  accountIds: string[]
  totalTrades: number
  dailyProfitBdt: number | string
  dailyLossBdt: number | string
  issues?: string | null
  screenshotProof?: string | null
  operationalNotes?: string | null
  submittedAt: string
  user?: { id: string; name: string; email?: string | null; employeeIdGas?: string | null }
}

export type TradingHrEmployee = {
  user: TradingUser & {
    phone?: string | null
    joiningDate?: string | null
  }
  profile?: TradingEmployeeProfile | null
  assignedAccounts: Array<{
    id: string
    accountTitle: string
    status: TradingAccountStatus
    currentBalance: number
    netRoi: number
    merchantProgress: number
  }>
  metrics: {
    totalAccountsManaged: number
    activeAccounts: number
    totalTrades: number
    totalTradedUsdt: number
    totalProfitGenerated: number
    totalLosses: number
    netResult: number
    roiContribution: number
    merchantGrowthSuccess: number
    activityConsistency: number
    screenshotConsistency: number
    reportConsistency: number
    expensesManaged: number
    lastActiveAt?: string | null
    inactiveDays: number
    todayReportSubmitted: boolean
  }
  wallet?: {
    totalAccrued: number
    totalCommissions: number
    totalPerformanceBonuses: number
    totalAdvances: number
    totalWithdrawals: number
    totalPenalties: number
    currentBalance: number
    availableWithdrawable: number
  } | null
}

export type TradingHrResponse = {
  employees: TradingHrEmployee[]
  alerts: Array<{ severity: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'; type: string; userId: string; title: string; message: string }>
  rankings: {
    topTrader: TradingHrEmployee[]
    mostProfitable: TradingHrEmployee[]
    lowestLossRatio: TradingHrEmployee[]
    bestMerchantGrowth: TradingHrEmployee[]
    mostActive: TradingHrEmployee[]
  }
  kpis: {
    totalEmployees: number
    activeEmployees: number
    totalManagedAccounts: number
    totalProfitGenerated: number
    totalLosses: number
    totalCommissions: number
    totalWalletBalance: number
    missingReports: number
  }
}

export type TradingHrProfileInput = {
  userId: string
  employeeIdGas?: string
  roleTitle?: string
  shift?: 'DAY' | 'NIGHT' | string
  status?: string
  salary?: number
  commissionType?: TradingCommissionType
  commissionRate?: number
  fixedCommission?: number
  merchantCompletionBonus?: number
  milestoneBonus?: number
  notes?: string
  joiningDate?: string
}

export type TradingEmployeeReportInput = {
  userId?: string
  reportDate?: string
  accountIds?: string[]
  totalTrades?: number
  dailyProfitBdt?: number
  dailyLossBdt?: number
  issues?: string
  screenshotProof?: string
  operationalNotes?: string
}

export type TradingAnalyticsFilters = {
  startDate?: string
  endDate?: string
  staffId?: string
  accountId?: string
  status?: string
  profitability?: string
  minRoi?: string
  maxRoi?: string
}

export type TradingAnalyticsAccount = {
  id: string
  accountTitle: string
  assignedUserId?: string | null
  assignedUserName: string
  status: string
  currentBalance: number
  startingCapital: number
  totalProfit: number
  totalLoss: number
  totalFees: number
  totalExpenses: number
  totalUsdt: number
  totalBuyUsdt: number
  totalSellUsdt: number
  totalBuyBdt: number
  totalSellBdt: number
  netProfit: number
  roi: number
  avgBuyRate: number
  avgSellRate: number
  averageSpread: number
  feeRatio: number
  expenseRatio: number
  merchantProgress: number
  health: 'HEALTHY' | 'MODERATE_RISK' | 'HIGH_RISK' | 'LOSS_HEAVY'
}

export type TradingAnalyticsStaff = {
  userId: string
  name: string
  assignedAccounts: number
  activeAccounts: number
  totalManagedCapital: number
  totalTradedUsdt: number
  totalProfitGenerated: number
  totalLossGenerated: number
  feeEfficiency: number
  averageSpread: number
  roiContribution: number
  monthlyNetResult: number
}

export type TradingAnalyticsResponse = {
  filters: TradingAnalyticsFilters
  kpis: {
    totalManagedCapital: number
    todayNet: number
    weeklyNet: number
    monthlyNet: number
    totalUsdtVolume: number
    totalBuyUsdt: number
    totalSellUsdt: number
    totalBinanceFees: number
    totalOperatingExpenses: number
    activeMerchantAccounts: number
    activeStaffCount: number
  }
  topProfitableAccounts: TradingAnalyticsAccount[]
  topLossAccounts: TradingAnalyticsAccount[]
  bestSpreadAccounts: TradingAnalyticsAccount[]
  highestExpenseAccounts: TradingAnalyticsAccount[]
  staff: TradingAnalyticsStaff[]
  expenseCategories: Array<{ type: string; amount: number }>
  trend: Array<{ date: string; netBdt: number; usdtVolume: number; buyUsdtVolume: number; sellUsdtVolume: number; expenseBdt: number; tradeCount: number }>
  alerts: Array<{ severity: 'HIGH' | 'NORMAL'; type: string; accountId: string; accountTitle: string; message: string }>
  recent: {
    trades: TradingTrade[]
    expenses: TradingExpense[]
    capitalEntries: TradingCapitalEntry[]
  }
  reportRows: TradingAnalyticsAccount[]
}

export type TradingDashboardResponse = {
  kpis: {
    activeAccounts: number
    todayTradeCount: number
    todayProfit: number
    todayLoss: number
    todayFees: number
    todayBuyUsdt: number
    todaySellUsdt: number
    todayBuyBdt: number
    todaySellBdt: number
    netTodayResult: number
    totalCapital: number
    currentBalance: number
    totalExpenses: number
    totalTradeVolume: number
    totalUsdtVolume: number
    activeStaffCount: number
  }
  accountPerformance: Array<{
    id: string
    accountTitle: string
    status: TradingAccountStatus
    assignedStaff: string
    assignedUserId?: string | null
    currentBalance: number
    startingCapital: number
    dailyPl: number
    weeklyPl: number
    previousWeeklyPl: number
    roi: number
    expenseRatio: number
    feeTotals: number
    merchantProgress: number
    activityStatus: 'ACTIVE_TODAY' | 'ACTIVE_RECENTLY' | 'INACTIVE'
    health: 'PROFITABLE' | 'STABLE' | 'RISK' | 'LOSS'
    merchantGrowthScore: number
    merchantGrowthTrend: 'UP' | 'DOWN' | 'FLAT'
    capitalUtilization: number
    lossExposure: number
    feeBurden: number
    inactiveDays: number
    lossStreak: number
    totalProfit: number
    totalLoss: number
    totalExpenses: number
    totalTradeVolume: number
    totalUsdtVolume: number
    lastScreenshotAt?: string | null
    screenshotCount: number
    screenshotToday?: boolean
    screenshotCompliance?: 'COMPLETE' | 'DUE' | 'OVERDUE' | 'NOT_REQUIRED'
    balanceDebug?: TradingBalanceDebug
  }>
  screenshotCompliance?: {
    cutoffHourBd: number
    pastCutoff: boolean
    completeCount: number
    dueCount: number
    overdueCount: number
  }
  alerts: Array<{
    key: string
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
    title: string
    message: string
    accountId: string
    accountTitle: string
    actionUrl: string
  }>
  merchantGrowth: {
    averageScore: number
    trend: 'UP' | 'DOWN' | 'FLAT'
    weeklyComparison: number
  }
  capitalRisk: {
    remainingCapital: number
    capitalUtilization: number
    lossExposure: number
    feeBurden: number
  }
  staffRankings: {
    topPerformer: TradingStaffRanking | null
    lowestPerformer: TradingStaffRanking | null
    rows: TradingStaffRanking[]
  }
  trend: Array<{ date: string; netBdt: number; profit: number; loss: number; usdtVolume: number; tradeCount: number }>
  latestTrades: TradingTrade[]
  latestExpenses: TradingExpense[]
  latestCapitalEntries: TradingCapitalEntry[]
}

export type TradingStaffRanking = {
  userId: string
  name: string
  managedAccounts: number
  totalProfitGenerated: number
  managedCapital: number
  activityConsistency: number
  expenseEfficiency: number
  commissionEarned: number
  score: number
}

export type TradingAccountListItem = TradingAccount & {
  partnershipNetStaffOwes?: number | null
}

export type TradingAccountsResponse = {
  accounts: TradingAccountListItem[]
  total: number
}

export type TradingAccountDetailResponse = {
  account: TradingAccount
  summary: TradingSummary
  today: TradingDailySummary
  ranges?: {
    today: TradingDailySummary
    yesterday: TradingDailySummary
    last7: TradingDailySummary
    currentMonth: TradingDailySummary
  }
  recentTrades: TradingTrade[]
  recentExpenses: TradingExpense[]
  recentCapitalEntries: TradingCapitalEntry[]
  bkashSummaries?: TradingBkashDailySummary[]
  performanceScreenshots?: TradingPerformanceScreenshot[]
  timeline?: Array<{
    id: string
    type: string
    occurredAt: string
    label: string
    amount: number
    profitDelta: number
    runningBalance: number
    runningProfit: number
  }>
  balanceDebug?: TradingBalanceDebug
}

export type TradingBalanceDebug = {
  rawCalculatedBalance: number
  ledgerTotal: number
  expenseTotal: number
  pendingAdjustments: number
  lastRecalculatedAt: string
}

export type TradingBkashDailySummary = {
  id: string
  tradingAccountId: string
  businessId: 'ALMA_TRADING'
  summaryDate: string
  totalOrders: number
  totalProfitBdt: number | string
  totalLossBdt: number | string
  netResultBdt: number | string
  notes?: string | null
  createdBy: string
  createdAt: string
  creator?: { name: string }
}

export type TradingPerformanceScreenshot = {
  id: string
  tradingAccountId: string
  businessId: 'ALMA_TRADING'
  shotDate: string
  employeeId?: string | null
  driveFileId: string
  driveFolderId?: string | null
  previewUrl?: string | null
  originalName: string
  contentType: string
  sizeBytes: number
  note?: string | null
  expiryDate: string
  archivedAt?: string | null
  uploadedBy: string
  createdAt: string
  signedUrl?: string
  uploader?: { name: string }
}

export type TradingAccountInput = {
  assignedUserId?: string | null
  accountTitle: string
  binanceUid?: string | null
  accountType?: TradingAccountType
  status?: TradingAccountStatus
  startingCapital?: number
  merchantTarget?: number | null
  commissionType?: TradingCommissionType
  commissionRate?: number
  fixedCommission?: number
  completionBonus?: number
  startDate?: string
  completedDate?: string | null
  notes?: string | null
  partnershipEnabled?: boolean
  staffSharePercent?: number
}

export type TradingPartnershipSettleInput = {
  notes?: string
  adminOverrideBdt?: number | null
  postToWallet?: boolean
}

export type TradingTradeInput = {
  tradingAccountId: string
  tradeType: TradingTradeType
  usdtAmount: number
  bdtRate: number
  buyRateBdt?: number
  sellRateBdt?: number
  feeUsdt?: number
  notes?: string
}

export type TradingTradeActionInput = {
  action?: 'edit' | 'request_delete' | 'approve_delete' | 'reject_delete'
  tradeType?: TradingTradeType
  usdtAmount?: number
  bdtRate?: number
  feeUsdt?: number
  tradeDate?: string
  notes?: string
  editReason?: string
  deleteReason?: string
  rejectionReason?: string
}

export type TradingExpenseInput = {
  tradingAccountId: string
  expenseType: string
  amount: number
  paidBy?: TradingExpensePaidBy
  notes?: string
  attachmentUrl?: string | null
  expenseDate?: string
}

export type TradingBkashSummaryInput = {
  tradingAccountId: string
  summaryDate?: string
  totalOrders: number
  totalProfitBdt: number
  totalLossBdt: number
  notes?: string
}

export type TradingCapitalInput = {
  tradingAccountId: string
  entryType: TradingCapitalEntryType
  amount: number
  notes?: string
}

export type TradingMutationResponse = {
  ok: boolean
  trade?: TradingTrade
  expense?: TradingExpense
  capitalEntry?: TradingCapitalEntry
  bkashSummary?: TradingBkashDailySummary
  summary: TradingSummary
}

export type TradingTradeActionResponse = {
  ok: boolean
  trade: TradingTrade
  summary?: TradingSummary
}
