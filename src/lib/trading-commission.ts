import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createCompensationLedgerEntry } from '@/lib/payroll-compensation'
import { periodFromDate } from '@/lib/payroll-wallet'
import { TRADING_BUSINESS_ID } from '@/lib/trading'
import { logEvent, errorMeta } from '@/lib/logger'

type TradingCommissionAccount = {
  id: string
  accountTitle: string
  assignedUser?: { id?: string | null; employeeIdGas?: string | null } | null
  commissionType: 'NONE' | 'PERCENTAGE' | 'FIXED'
  commissionRate: unknown
  fixedCommission: unknown
  completionBonus: unknown
}

export async function postTradingTradeCommission(input: {
  account: TradingCommissionAccount
  tradeId: string
  tradeDate: Date
  netProfitBdt: number
  actorUserId?: string | null
}) {
  const employeeId = input.account.assignedUser?.employeeIdGas?.trim()
  if (!employeeId || input.netProfitBdt <= 0) {
    return { ok: true, skipped: 'not_commissionable' }
  }
  let commissionType = input.account.commissionType
  let commissionRate = Number(input.account.commissionRate || 0)
  let fixedCommission = Number(input.account.fixedCommission || 0)
  if (commissionType === 'NONE' && input.account.assignedUser?.id) {
    const profile = await prisma.tradingEmployeeProfile.findUnique({
      where: { userId: input.account.assignedUser.id },
      select: { commissionType: true, commissionRate: true, fixedCommission: true },
    })
    if (profile) {
      commissionType = profile.commissionType
      commissionRate = Number(profile.commissionRate || 0)
      fixedCommission = Number(profile.fixedCommission || 0)
    }
  }
  if (commissionType === 'NONE') return { ok: true, skipped: 'not_commissionable' }
  const amount = commissionType === 'PERCENTAGE'
    ? input.netProfitBdt * (commissionRate / 100)
    : fixedCommission
  if (!Number.isFinite(amount) || amount <= 0) return { ok: true, skipped: 'commission_zero' }

  try {
    const entry = await createCompensationLedgerEntry({
      employeeId,
      businessId: TRADING_BUSINESS_ID,
      type: 'COMMISSION',
      amount,
      effectiveDate: input.tradeDate,
      periodYm: periodFromDate(input.tradeDate),
      note: `Trading commission · ${input.account.accountTitle} · trade ${input.tradeId}`,
      createdById: input.actorUserId || null,
      approvedById: input.actorUserId || null,
      source: 'trading_trade_commission',
      sourceRef: `trading-trade-commission:${input.tradeId}`,
    })
    return { ok: true, entryId: entry.id, employeeId, amount }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { ok: true, skipped: 'commission_already_exists' }
    }
    logEvent('error', 'trading.commission_failed', { ...errorMeta(e), tradeId: input.tradeId, accountId: input.account.id })
    return { ok: false, error: (e as Error).message }
  }
}

export async function postTradingCompletionBonus(input: {
  account: TradingCommissionAccount
  actorUserId?: string | null
}) {
  const employeeId = input.account.assignedUser?.employeeIdGas?.trim()
  let amount = Number(input.account.completionBonus || 0)
  if ((!Number.isFinite(amount) || amount <= 0) && input.account.assignedUser?.id) {
    const profile = await prisma.tradingEmployeeProfile.findUnique({
      where: { userId: input.account.assignedUser.id },
      select: { merchantCompletionBonus: true, milestoneBonus: true },
    })
    amount = Number(profile?.merchantCompletionBonus || profile?.milestoneBonus || 0)
  }
  if (!employeeId || !Number.isFinite(amount) || amount <= 0) return { ok: true, skipped: 'completion_bonus_zero' }
  try {
    const entry = await createCompensationLedgerEntry({
      employeeId,
      businessId: TRADING_BUSINESS_ID,
      type: 'PERFORMANCE_BONUS',
      amount,
      note: `Merchant completion bonus · ${input.account.accountTitle}`,
      createdById: input.actorUserId || null,
      approvedById: input.actorUserId || null,
      source: 'trading_completion_bonus',
      sourceRef: `trading-completion-bonus:${input.account.id}`,
    })
    return { ok: true, entryId: entry.id, employeeId, amount }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { ok: true, skipped: 'completion_bonus_already_exists' }
    }
    logEvent('error', 'trading.completion_bonus_failed', { ...errorMeta(e), accountId: input.account.id })
    return { ok: false, error: (e as Error).message }
  }
}
