import type { AttendanceWaiverRequest, EmployeeLedgerEntry } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { APPEAL_WINDOW_DAYS, appealDeadline, finalAppliedPenalty } from '@/lib/penalty-appeal'

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
  /** True while staff may still file (no completed appeal, within 30 days). */
  appealable: boolean
  deadline: string
  daysLeft: number
  waiverId: string | null
  attendanceRecordId: string | null
  refundEntryId: string | null
  refundedAmount: number
  adminNote: string | null
  reviewedAt: string | null
}

const REFUND_SOURCES = new Set([
  'attendance_late_penalty_reversal',
  'attendance_exception_refund',
  'attendance_reset_reversal',
])

function daysLeftInWindow(fineDate: Date, now: Date): number {
  const ms = appealDeadline(fineDate).getTime() - now.getTime()
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}

type WaiverLite = Pick<
  AttendanceWaiverRequest,
  'id' | 'status' | 'adminNote' | 'reviewedAt' | 'reversalLedgerEntryId' | 'penaltyLedgerEntryId' | 'attendanceRecordId' | 'approvedReductionAmount' | 'originalPenaltyAmount'
>

/**
 * Builds entryId → appeal info for every PENALTY entry. Joins by the new
 * waiver.penaltyLedgerEntryId link, with a fallback join through
 * AttendanceRecord.penaltyLedgerEntryId for waivers created before the link.
 */
export async function mapFineAppeals(
  entries: Pick<EmployeeLedgerEntry, 'id' | 'type' | 'date' | 'employeeId' | 'businessId'>[],
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
        id: true, status: true, adminNote: true, reviewedAt: true,
        reversalLedgerEntryId: true, penaltyLedgerEntryId: true,
        attendanceRecordId: true, approvedReductionAmount: true, originalPenaltyAmount: true,
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
        penaltyLedgerEntryId: true,
        earlyLeavePenaltyLedgerEntryId: true,
        noCheckoutFineLedgerEntryId: true,
      },
    }),
  ])

  // entryId → attendanceRecordId across every fine-link column, and the reverse
  // (record → all its fine entryIds) for the waiver fallback join.
  const entryToRecord = new Map<string, string>()
  const recordToEntries = new Map<string, string[]>()
  for (const r of records) {
    for (const eid of [r.penaltyLedgerEntryId, r.earlyLeavePenaltyLedgerEntryId, r.noCheckoutFineLedgerEntryId]) {
      if (!eid) continue
      entryToRecord.set(eid, r.id)
      const arr = recordToEntries.get(r.id) ?? []
      arr.push(eid)
      recordToEntries.set(r.id, arr)
    }
  }

  const byEntry = new Map<string, WaiverLite>()
  for (const w of waivers) {
    // One waiver covers the whole attendance record (the server sums every fine
    // on that day), so surface it on all of the record's fine entries — not just
    // the late check-in one — when the waiver has no direct penalty-entry link.
    const targetEntries = w.penaltyLedgerEntryId
      ? [w.penaltyLedgerEntryId]
      : (w.attendanceRecordId ? recordToEntries.get(w.attendanceRecordId) ?? [] : [])
    for (const eid of targetEntries) {
      if (eid && !byEntry.has(eid)) byEntry.set(eid, w)
    }
  }

  const result: Record<string, FineAppealInfo> = {}
  for (const fine of fines) {
    const w = byEntry.get(fine.id) || null
    const withinWindow = now.getTime() <= appealDeadline(fine.date).getTime()
    let status: FineAppealStatus
    if (w && w.status !== 'CANCELLED') status = w.status as FineAppealStatus
    else if (!withinWindow) status = 'EXPIRED'
    else status = w ? 'CANCELLED' : 'NONE'

    // Staff may (re-)file while inside the window unless an appeal is pending
    // or already granted; REJECTED/CANCELLED reopen (matches submitPenaltyAppeal).
    const appealable = withinWindow && (!w || w.status === 'REJECTED' || w.status === 'CANCELLED')

    result[fine.id] = {
      status,
      appealable,
      deadline: appealDeadline(fine.date).toISOString(),
      daysLeft: daysLeftInWindow(fine.date, now),
      waiverId: w?.id || null,
      attendanceRecordId: entryToRecord.get(fine.id) || w?.attendanceRecordId || null,
      refundEntryId: w?.reversalLedgerEntryId || null,
      refundedAmount: w && (w.status === 'APPROVED' || w.status === 'PARTIALLY_APPROVED')
        ? Number(w.originalPenaltyAmount || 0) - finalAppliedPenalty(Number(w.originalPenaltyAmount || 0), w.status, w.approvedReductionAmount == null ? null : Number(w.approvedReductionAmount))
        : 0,
      adminNote: w?.adminNote || null,
      reviewedAt: w?.reviewedAt?.toISOString() || null,
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

/**
 * Fine totals for a window. Refunds counted by entry `source` (all three
 * historical refund kinds) so legacy data stays visible.
 */
export function fineWindowSummary(
  entries: Pick<EmployeeLedgerEntry, 'id' | 'type' | 'source' | 'amount' | 'date'>[],
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
      fineTotal += Number(e.amount || 0)
      if (appeals[e.id]?.status === 'PENDING') pendingAppeals += 1
    } else if (e.type === 'ADJUSTMENT' && e.source && REFUND_SOURCES.has(e.source)) {
      refundCount += 1
      refundTotal += Number(e.amount || 0)
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
  entries: Pick<EmployeeLedgerEntry, 'id' | 'type' | 'source' | 'amount' | 'date'>[],
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
