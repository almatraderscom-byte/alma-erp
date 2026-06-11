import { prisma } from '@/lib/prisma'
import { createCompensationLedgerEntry } from '@/lib/payroll-compensation'
import { logEvent } from '@/lib/logger'

export const ATTENDANCE_RESET_REVERSAL_SOURCE = 'attendance_reset_reversal'

export function attendanceResetReversalSourceRef(recordId: string) {
  return `attendance_reset_reversal:${recordId}`
}

/** Remove an attendance check-in so the employee can check in again; reverses any posted late penalty. */
export async function resetAttendanceRecordByAdmin(recordId: string, actorUserId: string) {
  const record = await prisma.attendanceRecord.findUnique({
    where: { id: recordId },
    include: { waiverRequests: true, selfieVerifications: true },
  })
  if (!record || record.isArchived) {
    throw new Error('Attendance record not found')
  }

  const penaltyAmount = Number(record.penaltyAmount || 0)
  let penaltyReversed = 0

  if (penaltyAmount > 0) {
    const sourceRef = attendanceResetReversalSourceRef(recordId)
    const existing = await prisma.employeeLedgerEntry.findUnique({
      where: { source_sourceRef: { source: ATTENDANCE_RESET_REVERSAL_SOURCE, sourceRef } },
    })
    if (!existing) {
      await createCompensationLedgerEntry({
        employeeId: record.employeeId,
        businessId: record.businessId,
        type: 'ADJUSTMENT',
        amount: penaltyAmount,
        effectiveDate: new Date(),
        createdById: actorUserId,
        approvedById: actorUserId,
        source: ATTENDANCE_RESET_REVERSAL_SOURCE,
        sourceRef,
        note: `Attendance reset by admin — late penalty reversed · ${record.attendanceDate.toISOString().slice(0, 10)}`,
      })
      penaltyReversed = penaltyAmount
    }
  }

  await prisma.attendanceWaiverRequest.deleteMany({ where: { attendanceRecordId: recordId } })
  await prisma.attendanceSelfieVerification.deleteMany({ where: { attendanceRecordId: recordId } })
  await prisma.attendanceRecord.delete({ where: { id: recordId } })

  logEvent('info', 'attendance_reset_by_admin', {
    recordId,
    employeeId: record.employeeId,
    businessId: record.businessId,
    actorUserId,
    penaltyReversed,
  })

  return {
    ok: true,
    recordId,
    employeeId: record.employeeId,
    businessId: record.businessId,
    penaltyReversed,
  }
}
