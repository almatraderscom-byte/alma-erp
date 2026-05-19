import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { attendanceWaiverDto } from '@/lib/attendance'
import { dispatchApprovalsUpdated } from '@/lib/approvals'
import {
  createPenaltyAppealApproval,
  defaultRequestedReduction,
  notifyPenaltyAppealSubmitted,
  parseRequestType,
  penaltyAppealDto,
  validateAttachmentDataUrl,
} from '@/lib/penalty-appeal'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const ctx = await getWalletContext(req, url.searchParams.get('business_id'))
  if ('error' in ctx) return ctx.error

  const status = url.searchParams.get('status') || undefined
  const rows = await prisma.attendanceWaiverRequest.findMany({
    where: {
      businessId: ctx.businessIds[0],
      ...(ctx.isAdmin ? {} : { employeeId: ctx.employeeId }),
      ...(status ? { status: status as never } : {}),
    },
    include: {
      requester: { select: { name: true, email: true } },
      attendanceRecord: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return NextResponse.json({
    waivers: rows.map(row => ({
      ...penaltyAppealDto(row),
      requesterName: row.requester.name,
      requesterEmail: row.requester.email,
      lateMinutes: row.attendanceRecord.lateMinutes,
      attendanceDate: row.attendanceRecord.attendanceDate.toISOString(),
    })),
  })
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    business_id?: string
    attendance_record_id?: string
    reason?: string
    request_type?: string
    requested_reduction_amount?: number
    attachment_data_url?: string
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (ctx.isSystemOwner) {
    return NextResponse.json({ error: 'System owner accounts do not submit penalty appeals.' }, { status: 403 })
  }
  if (!ctx.employeeId) {
    return NextResponse.json({ error: 'Your user account is not linked to an HR employee ID.' }, { status: 400 })
  }

  const reason = String(body.reason || '').trim()
  if (!body.attendance_record_id || reason.length < 3) {
    return NextResponse.json({ error: 'Attendance record and explanation (3+ characters) are required.' }, { status: 400 })
  }

  const attachmentCheck = validateAttachmentDataUrl(body.attachment_data_url)
  if (!attachmentCheck.ok) {
    return NextResponse.json({ error: attachmentCheck.error }, { status: 400 })
  }

  const record = await prisma.attendanceRecord.findFirst({
    where: {
      id: body.attendance_record_id,
      businessId: ctx.businessIds[0],
      employeeId: ctx.employeeId,
      userId: ctx.userId,
    },
  })
  if (!record) return NextResponse.json({ error: 'Attendance record not found.' }, { status: 404 })
  const penalty = Number(record.penaltyAmount || 0)
  if (penalty <= 0) return NextResponse.json({ error: 'This attendance record has no late penalty.' }, { status: 400 })

  const requestType = parseRequestType(body.request_type)
  const requestedReduction = defaultRequestedReduction(penalty, requestType, body.requested_reduction_amount)

  try {
    const waiver = await prisma.attendanceWaiverRequest.create({
      data: {
        attendanceRecordId: record.id,
        businessId: record.businessId,
        userId: ctx.userId,
        employeeId: ctx.employeeId,
        requestType,
        originalPenaltyAmount: new Prisma.Decimal(penalty.toFixed(2)),
        requestedReductionAmount: new Prisma.Decimal(requestedReduction.toFixed(2)),
        reason: reason.slice(0, 1200),
        attachmentDataUrl: attachmentCheck.value || null,
      },
      include: { requester: { select: { name: true } } },
    })

    await createPenaltyAppealApproval(waiver, {
      employeeId: ctx.employeeId,
      userId: ctx.userId,
      userName: waiver.requester.name,
    })

    await notifyPenaltyAppealSubmitted(waiver, {
      employeeId: ctx.employeeId,
      userId: ctx.userId,
      userName: waiver.requester.name,
    })

    dispatchApprovalsUpdated()

    return NextResponse.json({ ok: true, waiver: penaltyAppealDto(waiver) })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ error: 'A review request already exists for this penalty.' }, { status: 409 })
    }
    throw e
  }
}
