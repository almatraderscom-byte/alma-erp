import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { moneyDecimal } from '@/lib/payroll-wallet'
import { forbidden, resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
import {
  withApiRoute,
  apiDataSuccess,
  apiFailure,
  requireWalletContext,
  parseJsonBody,
} from '@/lib/core/safe-route-helpers'

export const GET = withApiRoute('payroll.meal_allowance.profiles.list', async (req: NextRequest) => {
  const url = new URL(req.url)
  const auth = await requireWalletContext(req, url.searchParams.get('business_id'))
  if (!auth.ok) return auth.response
  const { ctx } = auth
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can view meal allowance profiles.')

  const businessId = resolveWalletScopeBusinessId(ctx.businessIds, url.searchParams.get('business_id'))

  const [profiles, users] = await Promise.all([
    prisma.mealAllowanceProfile.findMany({
      where: { businessId },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.user.findMany({
      where: {
        active: true,
        role: { not: 'SUPER_ADMIN' },
        employeeIdGas: { not: null },
        businessAccess: { contains: businessId },
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        employeeIdGas: true,
        role: true,
        businessAccess: true,
      },
      orderBy: { name: 'asc' },
    }),
  ])

  const profileByUserId = new Map(profiles.map(p => [p.userId, p]))
  const rows = users.map(user => ({
    user,
    profile: profileByUserId.get(user.id) ?? null,
  }))

  return apiDataSuccess({ businessId, rows })
})

export const PATCH = withApiRoute('payroll.meal_allowance.profiles.upsert', async (req: NextRequest) => {
  const body = await parseJsonBody<{
    business_id?: string
    userId?: string
    employeeId?: string
    enabled?: boolean
    amountBdt?: number
  }>(req)
  const auth = await requireWalletContext(req, body.business_id)
  if (!auth.ok) return auth.response
  const { ctx } = auth
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can update meal allowance profiles.')

  const userId = String(body.userId || '').trim()
  const employeeId = String(body.employeeId || '').trim()
  if (!userId || !employeeId) {
    return apiFailure('invalid_request', 'userId and employeeId are required', { status: 400 })
  }

  const enabled = body.enabled === true
  const amountBdt = Number(body.amountBdt || 0)
  if (enabled && (!Number.isFinite(amountBdt) || amountBdt <= 0)) {
    return apiFailure('invalid_request', 'amountBdt must be greater than 0 when enabling meal allowance', { status: 400 })
  }

  const businessId = resolveWalletScopeBusinessId(ctx.businessIds, body.business_id)

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, businessAccess: true, employeeIdGas: true },
  })
  if (!user) return apiFailure('not_found', 'User not found', { status: 404 })
  if (!user.businessAccess.includes(businessId)) {
    return apiFailure('forbidden', 'User does not have access to this business', { status: 403 })
  }

  const profile = await prisma.mealAllowanceProfile.upsert({
    where: { userId_businessId: { userId, businessId } },
    update: {
      employeeId,
      enabled,
      amountBdt: moneyDecimal(enabled ? amountBdt : amountBdt || 0),
      updatedById: ctx.userId,
    },
    create: {
      userId,
      businessId,
      employeeId,
      enabled,
      amountBdt: moneyDecimal(enabled ? amountBdt : 0),
      updatedById: ctx.userId,
    },
  })

  return apiDataSuccess({ profile })
})
