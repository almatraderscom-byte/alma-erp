import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
import { createMealAllowanceRequest, startOfUtcDay } from '@/lib/meal-allowance'
import {
  withApiRoute,
  apiDataSuccess,
  apiFailure,
  requireWalletContext,
  parseJsonBody,
} from '@/lib/core/safe-route-helpers'

export const GET = withApiRoute('payroll.meal_allowance.requests.list', async (req: NextRequest) => {
  const url = new URL(req.url)
  const auth = await requireWalletContext(req, url.searchParams.get('business_id'))
  if (!auth.ok) return auth.response
  const { ctx } = auth

  const businessId = resolveWalletScopeBusinessId(ctx.businessIds, url.searchParams.get('business_id'))
  const requests = await prisma.mealAllowanceRequest.findMany({
    where: {
      userId: ctx.userId,
      businessId,
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })

  return apiDataSuccess({ requests })
})

export const POST = withApiRoute('payroll.meal_allowance.requests.create', async (req: NextRequest) => {
  const body = await parseJsonBody<{
    business_id?: string
    reason?: string
    allowanceDate?: string
  }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth

  if (ctx.isSystemOwner) {
    return apiFailure('forbidden', 'System owner accounts do not submit meal allowance requests.', { status: 403 })
  }

  const employeeId = String(ctx.employeeId || '').trim()
  if (!employeeId) {
    return apiFailure('invalid_request', 'No employee profile linked to this account.', { status: 400 })
  }

  const businessId = resolveWalletScopeBusinessId(ctx.businessIds, body.business_id)
  const reason = String(body.reason || '').trim()
  const allowanceDate = parseAllowanceDate(body.allowanceDate)

  try {
    const user = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { name: true },
    })
    const result = await createMealAllowanceRequest({
      userId: ctx.userId,
      businessId,
      employeeId,
      amountBdt: 0,
      allowanceDate,
      reason,
      userName: user?.name || null,
    })
    return apiDataSuccess(result)
  } catch (e) {
    return apiFailure('invalid_request', (e as Error).message, { status: 400 })
  }
})

function parseAllowanceDate(raw: string | undefined): Date {
  if (!raw) return startOfUtcDay()
  const match = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return startOfUtcDay()
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}
