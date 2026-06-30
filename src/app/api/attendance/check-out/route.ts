import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  attendanceDateFor,
  attendanceRecordDto,
  calculateEarlyCheckoutPenalty,
  notifyEarlyLeavePenalty,
  postEarlyLeavePenalty,
  workDurationMinutes,
  normalizeClientMetadata,
  officeLocationFor,
  distanceMeters,
} from '@/lib/attendance'
import { checkoutRulesEnabled, checkoutTimeBlockEnabled, runCheckoutGates } from '@/lib/attendance-checkout-rules'
import { hasApprovedException } from '@/lib/attendance-exception'
import { leaveWaivesCheckout } from '@/lib/attendance-leave'
import { queueAttendanceCheckOutAlert } from '@/lib/telegram-notification/attendance-alerts'
import { getTelegramOpsSetting } from '@/lib/telegram-notification/settings'
import { archiveOpenAssignmentsOnCheckout } from '@/lib/operational-tasks'
import { withApiRoute, apiDataSuccess, apiFailure, requireWalletContext, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const POST = withApiRoute('attendance.check_out', async (req: NextRequest) => {
  const body = await parseJsonBody<{ business_id?: string; metadata?: unknown }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  if (ctx.isSystemOwner) {
    return apiFailure('forbidden', 'System owner accounts do not use employee attendance.', { status: 403 })
  }
  if (!ctx.employeeId) {
    return apiFailure('invalid_request', 'Your user account is not linked to an HR employee ID.', { status: 400 })
  }

  const attendanceDate = attendanceDateFor()
  const existing = await prisma.attendanceRecord.findUnique({
    where: {
      businessId_employeeId_attendanceDate: {
        businessId: ctx.businessIds[0],
        employeeId: ctx.employeeId,
        attendanceDate,
      },
    },
  })

  if (!existing) {
    return apiFailure('not_found', "Start work before ending today's attendance.", { status: 404 })
  }
  if (existing.checkOutAt) {
    return apiDataSuccess({
      duplicate: true,
      record: attendanceRecordDto({ ...existing, waiverRequests: [] }),
    })
  }

  const now = new Date()
  const businessId = ctx.businessIds[0]
  const meta = normalizeClientMetadata(body.metadata)
  const location = meta.location

  // Checkout-discipline gates. The 8 PM TIME block is ALWAYS on for
  // ALMA_LIFESTYLE (Option A — server-side hard block, every platform incl.
  // iPhone/Safari). The location + 75%-task gates stay behind the kill-switch
  // (checkoutRulesEnabled) until the owner turns them on. Owner-approved
  // exceptions/leave still waive everything. Returns a Bangla 403 with a
  // machine-readable code on the first failed gate.
  const enforceExtraGates = checkoutRulesEnabled(businessId)
  if (checkoutTimeBlockEnabled(businessId) || enforceExtraGates) {
    const gate = await runCheckoutGates({
      businessId,
      userId: ctx.userId,
      attendanceDate,
      now,
      location,
      enforceExtraGates,
    })
    if (!gate.ok) {
      return apiFailure('forbidden', gate.message, {
        status: 403,
        extra: { code: gate.code, ...('meta' in gate ? gate.meta : {}) },
      })
    }
  }

  // Persist the checkout GPS (audit trail for the geofence gate + appeals).
  const office = officeLocationFor(businessId)
  const checkOutDistanceFromOfficeM =
    office && location?.latitude != null && location?.longitude != null
      ? distanceMeters({ latitude: location.latitude, longitude: location.longitude }, office)
      : null

  const totalWorkMinutes = workDurationMinutes(existing.checkInAt, now)

  // Early checkout penalty ONLY for ALMA_LIFESTYLE. With the always-on 8 PM
  // block (Step 1), a before-8PM checkout only reaches here when an owner
  // approved exception/leave waived the block — in which case the owner
  // explicitly permitted leaving early, so NO penalty applies.
  let earlyMinutes = 0
  let earlyPenaltyAmount = 0
  if (businessId === 'ALMA_LIFESTYLE') {
    const calc = calculateEarlyCheckoutPenalty(now, businessId)
    earlyMinutes = calc.earlyMinutes
    earlyPenaltyAmount = calc.earlyPenaltyAmount
    if (earlyPenaltyAmount > 0) {
      const permitted =
        (await hasApprovedException(ctx.userId, businessId, attendanceDate, now)) ||
        (await leaveWaivesCheckout(ctx.userId, businessId, attendanceDate, now))
      if (permitted) {
        earlyMinutes = 0
        earlyPenaltyAmount = 0
      }
    }
  }
  const finalStatus = earlyPenaltyAmount > 0 ? 'EARLY_LEAVE' : 'COMPLETED'

  const record = await prisma.attendanceRecord.update({
    where: { id: existing.id },
    data: {
      checkOutAt: now,
      totalWorkMinutes,
      status: finalStatus,
      earlyLeaveMinutes: earlyMinutes > 0 ? earlyMinutes : null,
      earlyLeavePenaltyAmount: earlyPenaltyAmount > 0 ? new Prisma.Decimal(earlyPenaltyAmount.toFixed(2)) : null,
      checkOutLatitude: location?.latitude != null ? new Prisma.Decimal(location.latitude.toFixed(7)) : null,
      checkOutLongitude: location?.longitude != null ? new Prisma.Decimal(location.longitude.toFixed(7)) : null,
      checkOutLocationAccuracyM: location?.accuracy != null ? Math.round(location.accuracy) : null,
      checkOutDistanceFromOfficeM,
    },
    include: { waiverRequests: true },
  })

  if (earlyPenaltyAmount > 0) {
    await postEarlyLeavePenalty(record, ctx.userId)
    void notifyEarlyLeavePenalty(record, ctx.userId).catch(() => {})
  }

  const setting = await getTelegramOpsSetting(ctx.businessIds[0])
  const isEarly = totalWorkMinutes < setting.earlyLeaveMinutes
  queueAttendanceCheckOutAlert({ ...record, checkOutAt: now }, { earlyLeave: isEarly })

  if (ctx.userId) {
    void archiveOpenAssignmentsOnCheckout(ctx.userId).catch(() => {})
  }

  return apiDataSuccess({ record: attendanceRecordDto(record) })
})
