import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
import { createSalaryCorrectionRequest, SalaryCorrectionError } from '@/lib/salary-correction'
import { roundMoney } from '@/lib/money'
import {
  withApiRoute,
  apiDataSuccess,
  apiFailure,
  requireJwtRoles,
  requireWalletContext,
  parseJsonBody,
} from '@/lib/core/safe-route-helpers'

export const POST = withApiRoute('payroll.salary_corrections.create', async (req: NextRequest) => {
  const roleAuth = await requireJwtRoles(req, ['SUPER_ADMIN', 'ADMIN', 'HR'])
  if (!roleAuth.ok) return roleAuth.response

  const body = await parseJsonBody<{
    accrual_entry_id?: string
    employee_id?: string
    business_id?: string
    period_ym?: string
    proposed_amount?: number
    reason?: string
    reversals?: Array<{
      ledger_entry_id?: string
      amount?: number
      reason?: string
    }>
  }>(req)

  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  if (!ctx.isAdmin) {
    return apiFailure('forbidden', 'Only HR/Admin can request salary corrections.', { status: 403 })
  }

  const businessId = resolveWalletScopeBusinessId(ctx.businessIds, body.business_id)
  const accrualEntryId = String(body.accrual_entry_id || '').trim()
  const employeeId = String(body.employee_id || '').trim()
  const periodYm = String(body.period_ym || '').trim()
  const proposedAmount = roundMoney(Number(body.proposed_amount))
  const reason = String(body.reason || '').trim()

  if (!accrualEntryId || !employeeId || !periodYm) {
    return apiFailure('invalid_request', 'accrual_entry_id, employee_id, and period_ym are required.', { status: 400 })
  }
  if (!Number.isFinite(proposedAmount) || proposedAmount <= 0) {
    return apiFailure('invalid_request', 'proposed_amount must be greater than zero.', { status: 400 })
  }
  if (reason.length < 5) {
    return apiFailure('invalid_request', 'reason must be at least 5 characters.', { status: 400 })
  }

  const reversals = Array.isArray(body.reversals)
    ? body.reversals.map(row => ({
        ledgerEntryId: String(row.ledger_entry_id || '').trim(),
        amount: roundMoney(Number(row.amount)),
        reason: String(row.reason || '').trim(),
      }))
    : undefined

  try {
    const requester = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { name: true },
    })
    const { approval, payload } = await createSalaryCorrectionRequest({
      accrualEntryId,
      employeeId,
      businessId,
      periodYm,
      proposedAmount,
      reversals,
      requestedReason: reason,
      requestedById: ctx.userId,
      requestedByName: requester?.name || undefined,
    })

    return apiDataSuccess({
      request: payload,
      approval: {
        id: approval.id,
        status: approval.status,
        priority: approval.priority,
      },
    })
  } catch (e) {
    if (e instanceof SalaryCorrectionError) {
      return apiFailure(e.code || 'salary_correction_failed', e.message, { status: e.status })
    }
    return apiFailure('salary_correction_failed', (e as Error).message, { status: 500 })
  }
})
