import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { getJwt, forbidViewerWrite, validateMutationBusiness } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { resolveApprovalRequest } from '@/lib/approvals'
import { mirrorSalaryAdvanceToSheets } from '@/lib/payroll-sheets-mirror'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const denied = await forbidViewerWrite(req)
  if (denied) return denied

  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = normalizeAlmaRole(token.role as string)
  if (!['SUPER_ADMIN', 'ADMIN', 'HR'].includes(role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const body = (await req.json()) as { status?: 'APPROVED' | 'REJECTED'; note?: string }
    const status = body.status
    if (status !== 'APPROVED' && status !== 'REJECTED') {
      return NextResponse.json({ error: 'status APPROVED|REJECTED required' }, { status: 400 })
    }

    const adv = await prisma.salaryAdvanceRequest.findUnique({
      where: { id: params.id },
      include: { user: true },
    })
    if (!adv || adv.status !== 'PENDING') {
      return NextResponse.json({ error: 'Not pending' }, { status: 400 })
    }

    const bizErr = await validateMutationBusiness(req, adv.businessId)
    if (bizErr) return bizErr

    const reviewerName = String(token.name || token.email || 'Reviewer')

    if (status === 'REJECTED') {
      await prisma.salaryAdvanceRequest.update({
        where: { id: adv.id },
        data: {
          status: 'REJECTED',
          reviewedById: token.sub,
          reviewedAt: new Date(),
          reviewNote: body.note?.slice(0, 500) || null,
        },
      })
      await resolveApprovalRequest({
        module: 'PAYROLL',
        type: 'SALARY_ADVANCE',
        entityId: adv.id,
        status: 'REJECTED',
        actorUserId: token.sub,
        reason: body.note?.slice(0, 500) || 'Rejected',
      })
      return NextResponse.json({ ok: true })
    }

    const empId = adv.user.employeeIdGas?.trim()
    if (!empId) {
      return NextResponse.json({ error: 'User has no linked HR employee id — link profile first.' }, { status: 400 })
    }

    // Phase 1: Postgres is the source of truth. Persist + resolve approval first.
    await prisma.salaryAdvanceRequest.update({
      where: { id: adv.id },
      data: {
        status: 'APPROVED',
        reviewedById: token.sub,
        reviewedAt: new Date(),
        reviewNote: body.note?.slice(0, 500) || null,
      },
    })
    const approval = await resolveApprovalRequest({
      module: 'PAYROLL',
      type: 'SALARY_ADVANCE',
      entityId: adv.id,
      status: 'APPROVED',
      actorUserId: token.sub,
      reason: body.note?.slice(0, 500) || 'Approved',
    })

    // Best-effort Sheets mirror — Postgres state is final regardless of mirror outcome.
    const actorPayload = await mergeActorPayload(req, {})
    const mirror = await mirrorSalaryAdvanceToSheets({
      advanceId: adv.id,
      approvalId: approval?.id || adv.id,
      businessId: adv.businessId,
      empId,
      amount: Number(adv.amount),
      reason: adv.reason,
      requestedBy: adv.user.name || adv.user.email || adv.userId,
      approvedBy: reviewerName,
      note: body.note,
      actorPayload,
    })

    return NextResponse.json({
      ok: true,
      gas: mirror.ok ? mirror.gas : null,
      sheetsMirrored: mirror.ok,
      ...(mirror.ok ? {} : {
        warning: 'Salary advance approved in ERP. Mirror to payroll Sheets failed — re-push from admin payroll tools.',
        sheetsError: mirror.error,
      }),
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
