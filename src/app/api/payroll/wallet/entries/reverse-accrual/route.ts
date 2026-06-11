import { NextRequest } from 'next/server'
import { reverseSingleSalaryAccrual } from '@/lib/payroll-accrual-reversal'
import { withApiRoute, apiDataSuccess, apiFailure, parseJsonBody, requireWalletContext } from '@/lib/core/safe-route-helpers'
import { forbidden } from '@/lib/payroll-wallet-access'
import { normalizeAlmaRole } from '@/lib/roles'

const REVERSAL_ROLES = new Set(['SUPER_ADMIN', 'HR'])

export const POST = withApiRoute('payroll.wallet.reverse_accrual', async (req: NextRequest) => {
  const body = await parseJsonBody<{ accrual_entry_id?: string; business_id?: string }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  if (!REVERSAL_ROLES.has(normalizeAlmaRole(ctx.role))) {
    return forbidden('Only Super Admin or HR can reverse salary accruals.')
  }

  const accrualEntryId = String(body.accrual_entry_id || '').trim()
  if (!accrualEntryId) {
    return apiFailure('invalid_request', 'accrual_entry_id is required', { status: 400 })
  }

  const result = await reverseSingleSalaryAccrual(accrualEntryId, ctx.userId)
  return apiDataSuccess(result)
})
