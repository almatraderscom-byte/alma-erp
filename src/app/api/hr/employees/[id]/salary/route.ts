import { NextRequest, NextResponse } from 'next/server'
import { serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { getJwt, forbidViewerWrite, requireRoles, validateMutationBusiness } from '@/lib/api-guards'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { logEvent } from '@/lib/logger'

type GasSalaryPatchResult = {
  ok?: boolean
  error?: string
  emp_id?: string
  prev_salary?: number
  new_salary?: number
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const viewerDenied = await forbidViewerWrite(req)
  if (viewerDenied) return viewerDenied

  const roleDenied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN', 'HR'])
  if (roleDenied) return roleDenied

  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const employeeId = decodeURIComponent(params.id || '').trim()
  if (!employeeId) {
    return NextResponse.json({ error: 'Employee id required' }, { status: 400 })
  }

  try {
    const body = (await req.json()) as {
      amount?: number
      businessId?: string
      effectiveDate?: string
      reason?: string
    }

    const amount = roundMoney(Number(body.amount))
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive whole number' }, { status: 400 })
    }

    const businessId = String(body.businessId || 'ALMA_LIFESTYLE').trim()
    const bizErr = await validateMutationBusiness(req, businessId)
    if (bizErr) return bizErr

    const reason = body.reason != null ? String(body.reason).trim().slice(0, 500) : ''
    if (reason.length > 500) {
      return NextResponse.json({ error: 'reason must be at most 500 characters' }, { status: 400 })
    }

    const effectiveDate =
      body.effectiveDate && !Number.isNaN(Date.parse(body.effectiveDate))
        ? new Date(body.effectiveDate).toISOString()
        : new Date().toISOString()

    const gasPayload = await mergeActorPayload(req, {
      emp_id: employeeId,
      monthly_salary: amount,
      business_id: businessId,
      effective_date: effectiveDate.slice(0, 10),
      reason: reason || null,
    })

    let gasResult: GasSalaryPatchResult
    try {
      gasResult = await serverPost<GasSalaryPatchResult>('hr_patch_employee_salary', gasPayload)
    } catch (e) {
      return NextResponse.json(
        { error: 'GAS salary update failed', detail: (e as Error).message },
        { status: 502 },
      )
    }

    if (!gasResult?.ok) {
      return NextResponse.json(
        { error: gasResult?.error || 'GAS salary update failed', detail: gasResult },
        { status: 502 },
      )
    }

    const newSalary = roundMoney(Number(gasResult.new_salary ?? amount))
    const prevSalary = roundMoney(Number(gasResult.prev_salary ?? 0))

    const linkedUser = await prisma.user.findFirst({
      where: { employeeIdGas: employeeId, businessAccess: { contains: businessId } },
      select: { id: true },
    })

    if (linkedUser) {
      await prisma.user.update({
        where: { id: linkedUser.id },
        data: { salaryHint: newSalary },
      })
    } else {
      logEvent('warn', 'employee_salary_update.no_linked_user', {
        employeeId,
        businessId,
        newSalary,
      })
    }

    logEvent('info', 'employee_salary_update', {
      action: 'EMPLOYEE_SALARY_UPDATE',
      actorUserId: token.sub,
      targetEmployeeId: employeeId,
      businessId,
      prev_salary: prevSalary,
      new_salary: newSalary,
      effectiveDate,
      reason: reason || null,
    })

    return NextResponse.json({
      ok: true,
      employeeId,
      prev_salary: prevSalary,
      new_salary: newSalary,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
