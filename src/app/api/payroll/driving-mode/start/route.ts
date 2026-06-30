import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
import { createDrivingModeRequest, startDrivingModeByOwner } from '@/lib/driving-mode'
import {
  withApiRoute,
  apiDataSuccess,
  apiFailure,
  requireWalletContext,
  parseJsonBody,
} from '@/lib/core/safe-route-helpers'

export const POST = withApiRoute('payroll.driving_mode.start', async (req: NextRequest) => {
  const body = await parseJsonBody<{ business_id?: string; reason?: string; userId?: string }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  const businessId = resolveWalletScopeBusinessId(ctx.businessIds, body.business_id)

  // Owner/Admin may optionally trigger driving mode for a staff member; otherwise
  // the staff member starts it for themselves from MyDesk.
  const targetUserId = String(body.userId || '').trim()
  const startingForOther = targetUserId && targetUserId !== ctx.userId

  if (startingForOther && !ctx.isAdmin) {
    return apiFailure('forbidden', 'Only HR/Admin can start driving mode for another staff member.', { status: 403 })
  }
  if (!startingForOther && ctx.isSystemOwner) {
    return apiFailure('forbidden', 'System owner accounts do not use driving mode.', { status: 403 })
  }

  const userId = startingForOther ? targetUserId : ctx.userId
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, employeeIdGas: true },
  })
  const employeeId = startingForOther ? String(user?.employeeIdGas || '').trim() : String(ctx.employeeId || '').trim()
  if (!employeeId) {
    return apiFailure('invalid_request', 'No employee profile linked to this account.', { status: 400 })
  }

  try {
    // Owner/Admin starting it for a staff member activates immediately (the owner
    // is the approver, so no separate approval step). Staff self-start still needs
    // owner approval.
    if (startingForOther) {
      const result = await startDrivingModeByOwner({
        userId,
        businessId,
        employeeId,
        reason: body.reason,
        reviewerId: ctx.userId,
      })
      return apiDataSuccess(result)
    }
    const result = await createDrivingModeRequest({
      userId,
      businessId,
      employeeId,
      reason: body.reason,
      userName: user?.name || null,
      initiatedBy: 'staff',
    })
    return apiDataSuccess(result)
  } catch (e) {
    return apiFailure('invalid_request', (e as Error).message, { status: 400 })
  }
})
