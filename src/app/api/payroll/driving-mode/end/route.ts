import { NextRequest } from 'next/server'
import { resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
import { endDrivingModeSession } from '@/lib/driving-mode'
import {
  withApiRoute,
  apiDataSuccess,
  apiFailure,
  requireWalletContext,
  parseJsonBody,
} from '@/lib/core/safe-route-helpers'

export const POST = withApiRoute('payroll.driving_mode.end', async (req: NextRequest) => {
  const body = await parseJsonBody<{ business_id?: string; userId?: string }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  const businessId = resolveWalletScopeBusinessId(ctx.businessIds, body.business_id)

  const targetUserId = String(body.userId || '').trim()
  const endingForOther = targetUserId && targetUserId !== ctx.userId
  if (endingForOther && !ctx.isAdmin) {
    return apiFailure('forbidden', 'Only HR/Admin can end driving mode for another staff member.', { status: 403 })
  }

  const userId = endingForOther ? targetUserId : ctx.userId

  const result = await endDrivingModeSession({ userId, businessId, endedBy: ctx.userId })
  if (!result.session) {
    return apiFailure('not_found', 'No active driving mode session found.', { status: 404 })
  }
  return apiDataSuccess(result)
})
