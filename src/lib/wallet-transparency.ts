import type { AttendanceWaiverRequest, EmployeeLedgerEntry } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { APPEAL_WINDOW_DAYS, appealDeadline, finalAppliedPenalty } from '@/lib/penalty-appeal'
import { isFineAppealable } from '@/lib/penalty-appeal-policy'
import { resolveAttendancePenaltyTarget } from '@/lib/attendance-penalty-target'

/**
 * Staff wallet transparency: per-fine appeal status + fine totals for any window.
 *
 * Owner spec (2026-07-11): every fine transaction must carry its appeal history
 * (none / pending / approved / rejected, with the decision note), a staff-visible
 * 30-day appeal window, and clear totals — this month, last 30 days, a custom
 * range, and since joining.
 */

export type FineAppealStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'PARTIALLY_APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'

export type FineAppealInfo = {
  status: FineAppealStatus
  /** True only before this exact fine has ever been appealed, within 30 days. */
  appealable: boolean
  deadline: string
  daysLeft: number
  waiverId: string | null
  attendanceRecordId: string | null
  refundEntryId: string | null
  refundedAmount: number
  requestedReductionAmount: number | null
  approvedReductionAmount: number | null
  finalPenaltyAmount: number
  requestType: string | null
  reason: string | null
  adminNote: string | null
  reviewerName: string | null
  reviewedAt: string | null
  refundReconciled: boolean
  refundIssue: string | null
}

const APPEAL_REFUND_SOURCES = new Set(['attendance_late_penalty_reversal'])

type PenaltyRefundWaiver = Pick<
  AttendanceWaiverRequest,
  'status' | 'approvedReductionAmount' | 'reversalLedgerEntryId'
>
type PenaltyRefundEntry = Pick<EmployeeLedgerEntry, 'id' | 'type' | 'amount' | 'source' | 'relatedEntryId'>

export type PenaltyRefundReconciliation = {
  refundedAmount: number
  refundReconciled: boolean
  refundIssue: string | null
}

/**
 * Treat the wallet ledger as the source of truth for a completed appeal. The
 * decision amount is an expectation; it is not presented as paid until the
 * exact linked adjustment exists for the exact fine and amount.
 */
export function reconcilePenaltyAppealRefund(
  waiver: PenaltyRefundWaiver,
  penaltyLedgerEntryId: string | null | undefined,
  entryById: ReadonlyMap<string, PenaltyRefundEntry>,
): PenaltyRefundReconciliation {
  const approved = waiver.status === 'APPROVED' || waiver.status === 'PARTIALLY_APPROVED'
  if (!approved) return { refundedAmount: 0, refundReconciled: true, refundIssue: null }

  const expectedRefund = Number(waiver.approvedReductionAmount || 0)
  const refundEntry = waiver.reversalLedgerEntryId
    ? entryById.get(waiver.reversalLedgerEntryId)
    : null
  const refundLinked = Boolean(
    penaltyLedgerEntryId
    && refundEntry
    && refundEntry.type === 'ADJUSTMENT'
    && Boolean(refundEntry.source && APPEAL_REFUND_SOURCES.has(refundEntry.source))
    && refundEntry.relatedEntryId === penaltyLedgerEntryId
  )
  const actualRefund = refundLinked ? Math.max(0, Number(refundEntry?.amount || 0)) : 0
  const refundReconciled = refundLinked && Math.abs(actualRefund - expectedRefund) < 0.01
  const refundIssue = !refundEntry
    ? 'Approved refund ledger entry is missing.'
    : !refundLinked
      ? 'Refund ledger entry is not linked to this exact penalty.'
      : Math.abs(actualRefund - expectedRefund) >= 0.01
        ? `Decision amount and wallet credit differ (৳${expectedRefund} vs ৳${actualRefund}).`
        : null
  return { refundedAmount: actualRefund, refundReconciled, refundIssue }
}

function daysLeftInWindow(fineDate: Date, now: Date): number {
  const ms = appealDeadline(fineDate).getTime() - now.getTime()
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}

type WaiverLite = Pick<
  AttendanceWaiverRequest,
  'id' | 'status' | 'requestType' | 'reason' | 'adminNote' | 'reviewedAt' | 'reversalLedgerEntryId' | 'penaltyLedgerEntryId' | 'attendanceRecordId' | 'requestedReductionAmount' | 'approvedReductionAmount' | 'originalPenaltyAmount'
> & { reviewer: { name: string } | null }

/**
 * Builds entryId → appeal info for every PENALTY entry. Joins by the new
 * waiver.penaltyLedgerEntryId link. Legacy unlinked rows are inferred only
 * when their amount uniquely matches one posted fine on the attendance record.
 */
export async function mapFineAppeals(
  entries: Pick<EmployeeLedgerEntry, 'id' | 'type' | 'date' | 'employeeId' | 'businessId' | 'amount' | 'source' | 'relatedEntryId'>[],
  now = new Date(),
): Promise<Record<string, FineAppealInfo>> {
  const fines = entries.filter(e => e.type === 'PENALTY')
  if (!fines.length) return {}
  const fineIds = fines.map(f => f.id)
  const { employeeId, businessId } = fines[0]

  const [waivers, records] = await Promise.all([
    prisma.attendanceWaiverRequest.findMany({
      where: { employeeId, businessId, isArchived: false },
      select: {
        id: true, status: true, requestType: true, reason: true, adminNote: true, reviewedAt: true,
        reversalLedgerEntryId: true, penaltyLedgerEntryId: true,
        attendanceRecordId: true, requestedReductionAmount: true,
        approvedReductionAmount: true, originalPenaltyAmount: true,
        reviewer: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    // A fine row can be linked from ANY of the three AttendanceRecord penalty
    // columns — late check-in, early leave, or no-checkout. Match all three so
    // every fine type resolves to its attendanceRecordId, which is the value the
    // appeal button is gated on (web + iOS). Previously only penaltyLedgerEntryId
    // was matched, so early-leave / no-checkout fines never got an appeal button
    // even though the server accepts appeals for them.
    prisma.attendanceRecord.findMany({
      where: {
        OR: [
          { penaltyLedgerEntryId: { in: fineIds } },
          { earlyLeavePenaltyLedgerEntryId: { in: fineIds } },
          { noCheckoutFineLedgerEntryId: { in: fineIds } },
        ],
      },
      select: {
        id: true,
        penaltyAmount: true,
        penaltyLedgerEntryId: true,
        earlyLeavePenaltyAmount: true,
        earlyLeavePenaltyLedgerEntryId: true,
        noCheckoutFineAmount: true,
        noCheckoutFineLedgerEntryId: true,
      },
    }),
  ])

  // entryId → attendanceRecordId across every independent fine-link column.
  const entryToRecord = new Map<string, string>()
  const recordById = new Map(records.map(record => [record.id, record]))
  for (const r of records) {
    for (const eid of [r.penaltyLedgerEntryId, r.earlyLeavePenaltyLedgerEntryId, r.noCheckoutFineLedgerEntryId]) {
      if (!eid) continue
      entryToRecord.set(eid, r.id)
    }
  }

  const byEntry = new Map<string, WaiverLite>()
  for (const w of waivers) {
    const record = w.attendanceRecordId ? recordById.get(w.attendanceRecordId) : null
    const target = w.penaltyLedgerEntryId
      ? w.penaltyLedgerEntryId
      : record
        ? resolveAttendancePenaltyTarget(record, null, w.originalPenaltyAmount)?.ledgerEntryId
        : null
    if (target && !byEntry.has(target)) byEntry.set(target, w)
  }

  const result: Record<string, FineAppealInfo> = {}
  const entryById = new Map(entries.map(entry => [entry.id, entry]))
  for (const fine of fines) {
    const w = byEntry.get(fine.id) || null
    const withinWindow = now.getTime() <= appealDeadline(fine.date).getTime()
    let status: FineAppealStatus
    if (w && w.status !== 'CANCELLED') status = w.status as FineAppealStatus
    else if (!withinWindow) status = 'EXPIRED'
    else status = w ? 'CANCELLED' : 'NONE'

    // One exact wallet penalty can be appealed once. A rejected or requester-
    // cancelled appeal remains part of the immutable decision history.
    const appealable = isFineAppealable(withinWindow, Boolean(w))

    const reconciliation = w
      ? reconcilePenaltyAppealRefund(w, fine.id, entryById)
      : { refundedAmount: 0, refundReconciled: true, refundIssue: null }
    const original = Number(w?.originalPenaltyAmount ?? fine.amount ?? 0)

    result[fine.id] = {
      status,
      appealable,
      deadline: appealDeadline(fine.date).toISOString(),
      daysLeft: daysLeftInWindow(fine.date, now),
      waiverId: w?.id || null,
      attendanceRecordId: entryToRecord.get(fine.id) || w?.attendanceRecordId || null,
      refundEntryId: w?.reversalLedgerEntryId || null,
      refundedAmount: reconciliation.refundedAmount,
      requestedReductionAmount: w?.requestedReductionAmount == null ? null : Number(w.requestedReductionAmount),
      approvedReductionAmount: w?.approvedReductionAmount == null ? null : Number(w.approvedReductionAmount),
      finalPenaltyAmount: finalAppliedPenalty(original, w?.status ?? 'PENDING', w?.approvedReductionAmount == null ? null : Number(w.approvedReductionAmount)),
      requestType: w?.requestType || null,
      reason: w?.reason || null,
      adminNote: w?.adminNote || null,
      reviewerName: w?.reviewer?.name || null,
      reviewedAt: w?.reviewedAt?.toISOString() || null,
      refundReconciled: reconciliation.refundReconciled,
      refundIssue: reconciliation.refundIssue,
    }
  }
  return result
}

export type FineWindowSummary = {
  from: string | null
  to: string | null
  fineCount: number
  fineTotal: number
  refundCount: number
  refundTotal: number
  pendingAppeals: number
  /** fines minus refunds — what the fines actually cost in this window */
  netFineCost: number
}

function inWindow(d: Date, from: Date | null, to: Date | null) {
  if (from && d.getTime() < from.getTime()) return false
  if (to && d.getTime() > to.getTime()) return false
  return true
}

/** Fine totals for a window, attributing an appeal credit to its original fine
 * date. Permission/reset refunds are separate corrections and never inflate the
 * "appeal refund" metric. */
export function fineWindowSummary(
  entries: Pick<EmployeeLedgerEntry, 'id' | 'type' | 'source' | 'amount' | 'date' | 'relatedEntryId'>[],
  appeals: Record<string, FineAppealInfo>,
  from: Date | null,
  to: Date | null,
): FineWindowSummary {
  let fineCount = 0, fineTotal = 0, refundCount = 0, refundTotal = 0, pendingAppeals = 0
  for (const e of entries) {
    const d = new Date(e.date)
    if (!inWindow(d, from, to)) continue
    if (e.type === 'PENALTY') {
      fineCount += 1
      fineTotal += Math.abs(Number(e.amount || 0))
      if (appeals[e.id]?.status === 'PENDING') pendingAppeals += 1
      const appeal = appeals[e.id]
      if (appeal?.refundReconciled && appeal.refundedAmount > 0) {
        refundCount += 1
        refundTotal += appeal.refundedAmount
      }
    }
  }
  return {
    from: from?.toISOString() || null,
    to: to?.toISOString() || null,
    fineCount,
    fineTotal,
    refundCount,
    refundTotal,
    pendingAppeals,
    netFineCost: fineTotal - refundTotal,
  }
}

export function buildFineSummaries(
  entries: Pick<EmployeeLedgerEntry, 'id' | 'type' | 'source' | 'amount' | 'date' | 'relatedEntryId'>[],
  appeals: Record<string, FineAppealInfo>,
  range: { from: Date | null; to: Date | null },
  now = new Date(),
) {
  const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  return {
    appealWindowDays: APPEAL_WINDOW_DAYS,
    last30Days: fineWindowSummary(entries, appeals, last30Start, null),
    thisMonth: fineWindowSummary(entries, appeals, monthStart, null),
    sinceJoining: fineWindowSummary(entries, appeals, null, null),
    customRange: range.from || range.to ? fineWindowSummary(entries, appeals, range.from, range.to) : null,
  }
}
