import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createCompensationLedgerEntry } from '@/lib/payroll-compensation'
import { periodFromDate } from '@/lib/payroll-wallet'
import { TRADING_BUSINESS_ID, numberFromDecimal } from '@/lib/trading'

type Tx = Prisma.TransactionClient

type AccountPartnershipRow = {
  id: string
  accountTitle: string
  partnershipEnabled: boolean
  staffSharePercent: unknown
  totalProfit: unknown
  totalLoss: unknown
  partnershipBaselineProfit: unknown
  partnershipBaselineLoss: unknown
  partnershipBaselineOwnerExpenses: unknown
  partnershipBaselineStaffExpenses: unknown
  lastPartnershipSettledAt: Date | null
  startDate: Date
  assignedUser?: { employeeIdGas?: string | null } | null
}

export type PartnershipPreviewResult = {
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
  unsettledExpenses: Array<{
    id: string
    expenseType: string
    amount: number
    paidBy: 'OWNER' | 'STAFF' | null
    expenseDate: string
    notes: string | null
  }>
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function sharePct(account: Pick<AccountPartnershipRow, 'staffSharePercent'>) {
  const pct = Number(account.staffSharePercent ?? 50)
  return Number.isFinite(pct) && pct > 0 ? pct : 50
}

async function loadAccount(accountId: string, tx?: Tx): Promise<AccountPartnershipRow | null> {
  const db = tx ?? prisma
  return db.tradingAccount.findFirst({
    where: { id: accountId, businessId: TRADING_BUSINESS_ID, deletedAt: null },
    select: {
      id: true,
      accountTitle: true,
      partnershipEnabled: true,
      staffSharePercent: true,
      totalProfit: true,
      totalLoss: true,
      partnershipBaselineProfit: true,
      partnershipBaselineLoss: true,
      partnershipBaselineOwnerExpenses: true,
      partnershipBaselineStaffExpenses: true,
      lastPartnershipSettledAt: true,
      startDate: true,
      assignedUser: { select: { employeeIdGas: true } },
    },
  })
}

async function loadUnsettledExpenses(accountId: string, tx?: Tx) {
  const db = tx ?? prisma
  return db.tradingExpense.findMany({
    where: {
      tradingAccountId: accountId,
      businessId: TRADING_BUSINESS_ID,
      deletedAt: null,
      settlementId: null,
    },
    select: {
      id: true,
      expenseType: true,
      amount: true,
      paidBy: true,
      expenseDate: true,
      notes: true,
    },
    orderBy: { expenseDate: 'asc' },
  })
}

export function computePartnershipNumbers(
  account: Pick<
    AccountPartnershipRow,
    | 'partnershipEnabled'
    | 'staffSharePercent'
    | 'totalProfit'
    | 'totalLoss'
    | 'partnershipBaselineProfit'
    | 'partnershipBaselineLoss'
  >,
  unsettledExpenses: Array<{ amount: unknown; paidBy: 'OWNER' | 'STAFF' | null }>,
  periodEnd = new Date(),
  periodStart: Date | null = null,
): PartnershipPreviewResult {
  if (!account.partnershipEnabled) {
    return {
      partnershipEnabled: false,
      staffSharePercent: sharePct(account),
      periodStart: null,
      periodEnd: periodEnd.toISOString(),
      deltaProfitBdt: 0,
      deltaLossBdt: 0,
      netTradingDeltaBdt: 0,
      ownerPaidExpensesBdt: 0,
      staffPaidExpensesBdt: 0,
      staffTradingShareBdt: 0,
      expenseAdjustmentBdt: 0,
      netStaffOwesBdt: 0,
      unsettledExpenses: [],
    }
  }

  const pct = sharePct(account) / 100
  const deltaProfitBdt = round2(numberFromDecimal(account.totalProfit) - numberFromDecimal(account.partnershipBaselineProfit))
  const deltaLossBdt = round2(numberFromDecimal(account.totalLoss) - numberFromDecimal(account.partnershipBaselineLoss))
  const netTradingDeltaBdt = round2(deltaProfitBdt - deltaLossBdt)

  let ownerPaidExpensesBdt = 0
  let staffPaidExpensesBdt = 0
  for (const exp of unsettledExpenses) {
    const amt = numberFromDecimal(exp.amount)
    if (exp.paidBy === 'OWNER') ownerPaidExpensesBdt += amt
    else if (exp.paidBy === 'STAFF') staffPaidExpensesBdt += amt
  }
  ownerPaidExpensesBdt = round2(ownerPaidExpensesBdt)
  staffPaidExpensesBdt = round2(staffPaidExpensesBdt)

  const staffTradingShareBdt = netTradingDeltaBdt < 0 ? round2(Math.abs(netTradingDeltaBdt) * pct) : 0
  const expenseAdjustmentBdt = round2(ownerPaidExpensesBdt * pct - staffPaidExpensesBdt * pct)
  const netStaffOwesBdt = round2(staffTradingShareBdt + expenseAdjustmentBdt)

  return {
    partnershipEnabled: true,
    staffSharePercent: sharePct(account),
    periodStart: periodStart ? periodStart.toISOString() : null,
    periodEnd: periodEnd.toISOString(),
    deltaProfitBdt,
    deltaLossBdt,
    netTradingDeltaBdt,
    ownerPaidExpensesBdt,
    staffPaidExpensesBdt,
    staffTradingShareBdt,
    expenseAdjustmentBdt,
    netStaffOwesBdt,
    unsettledExpenses: [],
  }
}

export async function computePartnershipPreview(accountId: string, tx?: Tx): Promise<PartnershipPreviewResult> {
  const account = await loadAccount(accountId, tx)
  if (!account) throw new Error('Trading account not found')
  if (!account.partnershipEnabled) {
    return computePartnershipNumbers(account, [], new Date(), null)
  }

  const unsettled = await loadUnsettledExpenses(accountId, tx)
  const periodStart = account.lastPartnershipSettledAt ?? account.startDate
  const preview = computePartnershipNumbers(account, unsettled, new Date(), periodStart)
  preview.unsettledExpenses = unsettled.map(e => ({
    id: e.id,
    expenseType: e.expenseType,
    amount: numberFromDecimal(e.amount),
    paidBy: e.paidBy,
    expenseDate: e.expenseDate.toISOString(),
    notes: e.notes,
  }))
  return preview
}

export async function executePartnershipSettlement(
  accountId: string,
  input: {
    settledByUserId: string
    notes?: string
    adminOverrideBdt?: number | null
    postToWallet?: boolean
  },
) {
  return prisma.$transaction(async tx => {
    const account = await loadAccount(accountId, tx)
    if (!account) throw new Error('Trading account not found')
    if (!account.partnershipEnabled) throw new Error('Partnership is not enabled on this account')

    const unsettled = await loadUnsettledExpenses(accountId, tx)
    const periodStart = account.lastPartnershipSettledAt ?? account.startDate
    const periodEnd = new Date()
    const preview = computePartnershipNumbers(account, unsettled, periodEnd, periodStart)

    const finalNetStaffOwes =
      input.adminOverrideBdt != null && Number.isFinite(input.adminOverrideBdt)
        ? round2(input.adminOverrideBdt)
        : preview.netStaffOwesBdt

    const settlement = await tx.tradingPartnershipSettlement.create({
      data: {
        tradingAccountId: accountId,
        businessId: TRADING_BUSINESS_ID,
        periodStart,
        periodEnd,
        deltaProfitBdt: preview.deltaProfitBdt,
        deltaLossBdt: preview.deltaLossBdt,
        netTradingDeltaBdt: preview.netTradingDeltaBdt,
        ownerPaidExpensesBdt: preview.ownerPaidExpensesBdt,
        staffPaidExpensesBdt: preview.staffPaidExpensesBdt,
        staffSharePercent: preview.staffSharePercent,
        staffTradingShareBdt: preview.staffTradingShareBdt,
        expenseAdjustmentBdt: preview.expenseAdjustmentBdt,
        netStaffOwesBdt: finalNetStaffOwes,
        adminOverrideBdt: input.adminOverrideBdt ?? null,
        notes: input.notes?.trim() || null,
        settledByUserId: input.settledByUserId,
      },
    })

    if (unsettled.length > 0) {
      await tx.tradingExpense.updateMany({
        where: { id: { in: unsettled.map(e => e.id) } },
        data: { settlementId: settlement.id },
      })
    }

    const totalOwnerExp = numberFromDecimal(account.partnershipBaselineOwnerExpenses) + preview.ownerPaidExpensesBdt
    const totalStaffExp = numberFromDecimal(account.partnershipBaselineStaffExpenses) + preview.staffPaidExpensesBdt

    await tx.tradingAccount.update({
      where: { id: accountId },
      data: {
        partnershipBaselineProfit: numberFromDecimal(account.totalProfit),
        partnershipBaselineLoss: numberFromDecimal(account.totalLoss),
        partnershipBaselineOwnerExpenses: totalOwnerExp,
        partnershipBaselineStaffExpenses: totalStaffExp,
        lastPartnershipSettledAt: periodEnd,
      },
    })

    let ledgerEntryId: string | null = null
    if (input.postToWallet && finalNetStaffOwes !== 0) {
      const employeeId = account.assignedUser?.employeeIdGas?.trim()
      if (!employeeId) throw new Error('Assigned staff has no employee ID for wallet posting')
      const walletAmount = round2(-finalNetStaffOwes)
      const entry = await createCompensationLedgerEntry({
        employeeId,
        businessId: TRADING_BUSINESS_ID,
        type: 'ADJUSTMENT',
        amount: walletAmount,
        effectiveDate: periodEnd,
        periodYm: periodFromDate(periodEnd),
        note: `Partnership settlement · ${account.accountTitle} · ${settlement.id.slice(-8)}`,
        createdById: input.settledByUserId,
        approvedById: input.settledByUserId,
        source: 'trading_partnership_settlement',
        sourceRef: `trading-partnership-settlement:${settlement.id}`,
      })
      ledgerEntryId = entry.id
      await tx.tradingPartnershipSettlement.update({
        where: { id: settlement.id },
        data: { ledgerEntryId },
      })
    }

    return { settlement, ledgerEntryId, preview, finalNetStaffOwes }
  })
}

export async function listPartnershipSettlements(accountId: string, limit = 20) {
  return prisma.tradingPartnershipSettlement.findMany({
    where: { tradingAccountId: accountId, businessId: TRADING_BUSINESS_ID },
    include: { settledBy: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}
