import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { attendanceSelfieDto } from '@/lib/attendance'
import { notifyUser } from '@/lib/notifications'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => ({}))) as {
    business_id?: string
    action?: 'APPROVE' | 'REJECT'
    note?: string
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (ctx.role !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Only Super Admin can review verification selfies.' }, { status: 403 })
  }
  if (body.action !== 'APPROVE' && body.action !== 'REJECT') {
    return NextResponse.json({ error: 'action APPROVE|REJECT required' }, { status: 400 })
  }

  const selfie = await prisma.attendanceSelfieVerification.findFirst({
    where: { id: params.id, businessId: ctx.businessIds[0] },
    include: { attendanceRecord: true },
  })
  if (!selfie) return NextResponse.json({ error: 'Verification photo not found.' }, { status: 404 })

  const now = new Date()
  const note = String(body.note || '').trim().slice(0, 500) || null
  const updated = await prisma.attendanceSelfieVerification.update({
    where: { id: selfie.id },
    data: {
      reviewedAt: now,
      reviewedById: ctx.userId,
      reviewNote: note,
    },
  })

  await prisma.attendanceRecord.update({
    where: { id: selfie.attendanceRecordId },
    data: {
      verificationRequired: false,
      trustStatus: body.action === 'APPROVE' ? 'TRUSTED' : 'WARNING',
    },
  })

  await notifyUser({
    userId: selfie.userId,
    businessId: selfie.businessId,
    type: 'PAYROLL_ALERT',
    priority: 'HIGH',
    title: body.action === 'APPROVE' ? 'Attendance verification approved' : 'Attendance verification rejected',
    message: body.action === 'APPROVE'
      ? 'Your verification photo was approved by admin.'
      : note || 'Your verification photo was rejected. Contact admin if you need help.',
    actionUrl: '/portal',
  })

  return NextResponse.json({ ok: true, selfie: attendanceSelfieDto(updated) })
}
