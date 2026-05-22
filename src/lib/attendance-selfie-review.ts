import { prisma } from '@/lib/prisma'
import type { AttendanceSelfieVerification } from '@prisma/client'

type SelfieWithRecord = AttendanceSelfieVerification & {
  attendanceRecord: { id: string; businessId: string } | null
}

export type SelfieReviewLookup =
  | { ok: true; selfie: SelfieWithRecord }
  | { ok: false; status: 404 | 409; code: string; error: string; diagnostic?: string }

async function findByIdScoped(
  businessId: string,
  id: string,
  attendanceRecordId?: string | null,
): Promise<SelfieWithRecord | null> {
  const byId = await prisma.attendanceSelfieVerification.findFirst({
    where: { id, businessId },
    include: { attendanceRecord: true },
  })
  if (byId) return byId

  if (attendanceRecordId) {
    return prisma.attendanceSelfieVerification.findFirst({
      where: { attendanceRecordId, businessId },
      orderBy: { capturedAt: 'desc' },
      include: { attendanceRecord: true },
    })
  }

  return prisma.attendanceSelfieVerification.findFirst({
    where: { attendanceRecordId: id, businessId },
    orderBy: { capturedAt: 'desc' },
    include: { attendanceRecord: true },
  })
}

export async function resolveSelfieForAdminReview(input: {
  id: string
  businessId: string | null
  attendanceRecordId?: string | null
  isSuperAdmin: boolean
}): Promise<SelfieReviewLookup> {
  if (input.isSuperAdmin) {
    const byId = await prisma.attendanceSelfieVerification.findFirst({
      where: { id: input.id },
      include: { attendanceRecord: true },
    })
    if (!byId) {
      const byRecord = input.attendanceRecordId
        ? await prisma.attendanceSelfieVerification.findFirst({
            where: { attendanceRecordId: input.attendanceRecordId },
            orderBy: { capturedAt: 'desc' },
            include: { attendanceRecord: true },
          })
        : await prisma.attendanceSelfieVerification.findFirst({
            where: { attendanceRecordId: input.id },
            orderBy: { capturedAt: 'desc' },
            include: { attendanceRecord: true },
          })
      if (!byRecord) {
        return {
          ok: false,
          status: 404,
          code: 'photo_not_found',
          error: 'Verification photo not found.',
          diagnostic: 'No selfie row for this id or attendance record. Employee may need to check in again.',
        }
      }
      if (input.businessId && byRecord.businessId !== input.businessId) {
        return {
          ok: false,
          status: 409,
          code: 'business_mismatch',
          error: `Verification belongs to ${byRecord.businessId.replace(/_/g, ' ')}, not the selected business.`,
          diagnostic: 'Use the matching business scope or switch header business before approving.',
        }
      }
      return { ok: true, selfie: byRecord }
    }
    if (input.businessId && byId.businessId !== input.businessId) {
      return {
        ok: false,
        status: 409,
        code: 'business_mismatch',
        error: `Verification belongs to ${byId.businessId.replace(/_/g, ' ')}, not the selected business.`,
        diagnostic: 'Use the matching business scope or switch header business before approving.',
      }
    }
    return { ok: true, selfie: byId }
  }

  if (!input.businessId) {
    return {
      ok: false,
      status: 404,
      code: 'photo_not_found',
      error: 'Verification photo not found.',
    }
  }

  const selfie = await findByIdScoped(input.businessId, input.id, input.attendanceRecordId)
  if (!selfie) {
    return {
      ok: false,
      status: 404,
      code: 'photo_not_found',
      error: 'Verification photo not found.',
      diagnostic:
        'No stored verification asset for this request. If check-in succeeded today, ask the employee to open My Desk and retry verification.',
    }
  }
  return { ok: true, selfie }
}
