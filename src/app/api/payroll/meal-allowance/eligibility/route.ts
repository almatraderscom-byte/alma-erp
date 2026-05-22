import { NextRequest } from 'next/server'
import { resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
import { getMealAllowanceEligibility } from '@/lib/meal-allowance'
import { withApiRoute, apiDataSuccess, apiFailure, requireWalletContext } from '@/lib/core/safe-route-helpers'

export const GET = withApiRoute('payroll.meal_allowance.eligibility', async (req: NextRequest) => {
  const url = new URL(req.url)
  const auth = await requireWalletContext(req, url.searchParams.get('business_id'))
  if (!auth.ok) return auth.response
  const { ctx } = auth

  if (ctx.isSystemOwner) {
    return apiFailure('forbidden', 'System owner accounts do not use employee meal allowance.', { status: 403 })
  }

  const businessId = resolveWalletScopeBusinessId(ctx.businessIds, url.searchParams.get('business_id'))
  const eligibility = await getMealAllowanceEligibility(ctx.userId, businessId)

  return apiDataSuccess(eligibility)
})
