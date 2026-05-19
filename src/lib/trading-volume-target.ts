import { Prisma } from '@prisma/client'
import type { TradingDailyVolumeTarget, TradingVolumeTargetPenalty } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createCompensationLedgerEntry } from '@/lib/payroll-compensation'
import { TRADING_BUSINESS_ID, getTradingDailySummary, usdtDecimal } from '@/lib/trading'

export const TRADING_VOLUME_PENALTY_SOURCE = 'trading_volume_target_penalty'
export const TRADING_VOLUME_PENALTY_REVERSAL_SOURCE = 'trading_volume_target_penalty_reversal'

export function targetDateUtc(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function volumeTargetDto(
  row: TradingDailyVolumeTarget & {
    tradingAccount?: { accountTitle: string; assignedUserId: string | null; assignedUser?: { name: string; employeeIdGas: string | null } | null }
    penalties?: TradingVolumeTargetPenalty[]
  },
) {
  const penalty = row.penalties?.[0]
  const applied = Number(penalty?.appliedAmountBdt || 0)
  const waived = Number(penalty?.waivedAmountBdt || 0)
  return {
    id: row.id,
    businessId: row.businessId,
    tradingAccountId: row.tradingAccountId,
    accountTitle: row.tradingAccount?.accountTitle,
    assignedUserName: row.tradingAccount?.assignedUser?.name,
    employeeId: row.tradingAccount?.assignedUser?.employeeIdGas,
    targetDate: row.targetDate.toISOString(),
    targetUsdt: Number(row.targetUsdt),
    actualUsdt: Number(row.actualUsdt),
    shortfallUsdt: Math.max(0, Number(row.targetUsdt) - Number(row.actualUsdt)),
    status: row.status,
    penaltyAmountBdt: row.penaltyAmountBdt == null ? null : Number(row.penaltyAmountBdt),
    notes: row.notes,
    setById: row.setById,
    ignoredById: row.ignoredById,
    ignoredAt: row.ignoredAt?.toISOString() || null,
    penalty: penalty
      ? {
          id: penalty.id,
          status: penalty.status,
          originalAmountBdt: Number(penalty.originalAmountBdt),
          appliedAmountBdt: penalty.appliedAmountBdt == null ? null : Number(penalty.appliedAmountBdt),
          waivedAmountBdt: penalty.waivedAmountBdt == null ? null : Number(penalty.waivedAmountBdt),
          finalPenaltyBdt: Math.max(0, applied - waived),
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function refreshTargetActualVolume(targetId: string) {
  const target = await prisma.tradingDailyVolumeTarget.findUnique({
    where: { id: targetId },
    select: { id: true, tradingAccountId: true, targetDate: true, targetUsdt: true, status: true },
  })
  if (!target) return null

  const summary = await getTradingDailySummary(prisma, target.tradingAccountId, target.targetDate)
  const actualUsdt = summary.buyUsdtVolume + summary.sellUsdtVolume
  const targetUsdt = Number(target.targetUsdt)
  let status = target.status
  if (target.status !== 'IGNORED') {
    if (actualUsdt >= targetUsdt) status = 'MET'
    else if (actualUsdt > 0 || target.targetDate.getTime() < targetDateUtc().getTime()) status = 'MISSED'
    else status = 'PENDING'
  }

  const updated = await prisma.tradingDailyVolumeTarget.update({
    where: { id: targetId },
    data: { actualUsdt: usdtDecimal(actualUsdt), status },
  })

  if (status === 'MISSED' && target.status !== 'MISSED') {
    const { notifyMissedVolumeTarget } = await import('@/lib/trading-volume-target-telegram')
    void notifyMissedVolumeTarget(targetId).catch(() => undefined)

    const settings = await prisma.tradingVolumeTargetSettings.findUnique({
      where: { businessId: TRADING_BUSINESS_ID },
    })
    if (settings?.autoPenaltyEnabled) {
      const full = await prisma.tradingDailyVolumeTarget.findUnique({
        where: { id: targetId },
        include: { penalties: { where: { status: { in: ['APPLIED', 'PARTIALLY_WAIVED'] } } } },
      })
      if (full && !full.penalties.length) {
        const amt = full.penaltyAmountBdt ? Number(full.penaltyAmountBdt) : Number(settings.defaultPenaltyBdt)
        void applyVolumeTargetPenalty(targetId, null, amt, 'Auto-penalty (settings)').catch(() => undefined)
      }
    }
  }

  return updated
}

export async function writeVolumeTargetAudit(
  targetId: string,
  businessId: string,
  action: string,
  actorUserId: string | null,
  detail?: string,
  metadata?: Record<string, unknown>,
) {
  await prisma.tradingVolumeTargetAudit.create({
    data: {
      targetId,
      businessId,
      action,
      actorUserId,
      detail: detail?.slice(0, 1200) || null,
      metadataJson: metadata ? JSON.stringify(metadata).slice(0, 8000) : null,
    },
  })
}

export async function applyVolumeTargetPenalty(
  targetId: string,
  actorUserId: string | null,
  amountBdt: number,
  adminNote?: string,
) {
  const target = await prisma.tradingDailyVolumeTarget.findFirst({
    where: { id: targetId, businessId: TRADING_BUSINESS_ID },
    include: {
      tradingAccount: { include: { assignedUser: { select: { id: true, employeeIdGas: true, name: true } } } },
      penalties: { where: { status: { in: ['APPLIED', 'PARTIALLY_WAIVED'] } } },
    },
  })
  if (!target) return { error: 'Target not found.', status: 404 as const }
  if (target.status === 'IGNORED') return { error: 'Target failure was ignored.', status: 409 as const }
  const employeeId = target.tradingAccount.assignedUser?.employeeIdGas
  if (!employeeId) return { error: 'Account has no linked employee ID for wallet penalty.', status: 400 as const }
  if (target.penalties.length) return { error: 'Penalty already applied for this target.', status: 409 as const }

  const appliedAmount = Math.max(0, amountBdt)
  if (appliedAmount <= 0) return { error: 'Penalty amount must be positive.', status: 400 as const }

  const penalty = await prisma.tradingVolumeTargetPenalty.create({
    data: {
      targetId: target.id,
      businessId: target.businessId,
      employeeId,
      userId: target.tradingAccount.assignedUser?.id,
      status: 'APPLIED',
      originalAmountBdt: new Prisma.Decimal(appliedAmount.toFixed(2)),
      appliedAmountBdt: new Prisma.Decimal(appliedAmount.toFixed(2)),
      appliedById: actorUserId,
      appliedAt: new Date(),
      adminNote: adminNote?.slice(0, 1200) || null,
    },
  })

  const entry = await createCompensationLedgerEntry({
    employeeId,
    businessId: TRADING_BUSINESS_ID,
    type: 'PENALTY',
    amount: appliedAmount,
    effectiveDate: target.targetDate,
    createdById: actorUserId,
    approvedById: actorUserId,
    source: TRADING_VOLUME_PENALTY_SOURCE,
    sourceRef: `trading-volume-penalty:${penalty.id}`,
    note: `Trading volume target miss · ${target.tradingAccount.accountTitle}`,
  })

  await prisma.tradingVolumeTargetPenalty.update({
    where: { id: penalty.id },
    data: { penaltyLedgerEntryId: entry.id },
  })

  await prisma.tradingDailyVolumeTarget.update({
    where: { id: target.id },
    data: {
      penaltyAmountBdt: new Prisma.Decimal(appliedAmount.toFixed(2)),
      status: 'MISSED',
    },
  })

  await writeVolumeTargetAudit(target.id, target.businessId, 'PENALTY_APPLIED', actorUserId, adminNote, {
    amountBdt: appliedAmount,
    penaltyId: penalty.id,
    ledgerEntryId: entry.id,
  })

  return { ok: true as const, penaltyId: penalty.id }
}

export async function waiveVolumeTargetPenalty(
  targetId: string,
  actorUserId: string | null,
  waiveAmountBdt: number,
  adminNote?: string,
) {
  const penalty = await prisma.tradingVolumeTargetPenalty.findFirst({
    where: { targetId, businessId: TRADING_BUSINESS_ID, status: { in: ['APPLIED', 'PARTIALLY_WAIVED'] } },
    orderBy: { createdAt: 'desc' },
  })
  if (!penalty) return { error: 'No applied penalty to waive.', status: 404 as const }

  const applied = Number(penalty.appliedAmountBdt || 0)
  const waive = Math.min(applied, Math.max(0, waiveAmountBdt))
  if (waive <= 0) return { error: 'Waive amount must be positive.', status: 400 as const }

  const entry = await createCompensationLedgerEntry({
    employeeId: penalty.employeeId,
    businessId: TRADING_BUSINESS_ID,
    type: 'ADJUSTMENT',
    amount: waive,
    effectiveDate: new Date(),
    createdById: actorUserId,
    approvedById: actorUserId,
    source: TRADING_VOLUME_PENALTY_REVERSAL_SOURCE,
    sourceRef: `trading-volume-penalty-reversal:${penalty.id}`,
    note: `Trading volume target penalty waiver · ${penalty.id}`,
  })

  const totalWaived = Number(penalty.waivedAmountBdt || 0) + waive
  const nextStatus = totalWaived >= applied ? 'WAIVED' : 'PARTIALLY_WAIVED'

  await prisma.tradingVolumeTargetPenalty.update({
    where: { id: penalty.id },
    data: {
      status: nextStatus,
      waivedAmountBdt: new Prisma.Decimal(totalWaived.toFixed(2)),
      reversalLedgerEntryId: entry.id,
      waivedById: actorUserId,
      waivedAt: new Date(),
      adminNote: adminNote?.slice(0, 1200) || penalty.adminNote,
    },
  })

  await writeVolumeTargetAudit(targetId, penalty.businessId, 'PENALTY_WAIVED', actorUserId, adminNote, {
    waiveAmountBdt: waive,
    totalWaived,
    ledgerEntryId: entry.id,
  })

  return { ok: true as const, waived: waive, finalPenaltyBdt: Math.max(0, applied - totalWaived) }
}

export async function ignoreVolumeTargetFailure(targetId: string, actorUserId: string | null, note?: string) {
  const target = await prisma.tradingDailyVolumeTarget.findFirst({
    where: { id: targetId, businessId: TRADING_BUSINESS_ID },
  })
  if (!target) return { error: 'Target not found.', status: 404 as const }

  await prisma.tradingDailyVolumeTarget.update({
    where: { id: targetId },
    data: {
      status: 'IGNORED',
      ignoredById: actorUserId,
      ignoredAt: new Date(),
    },
  })

  await writeVolumeTargetAudit(targetId, target.businessId, 'TARGET_IGNORED', actorUserId, note)
  return { ok: true as const }
}
