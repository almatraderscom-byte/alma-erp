import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { getCompensationSetting } from '@/lib/payroll-compensation'
import { moneyDecimal } from '@/lib/payroll-wallet'

export async function GET(req: NextRequest) {
  const businessId = new URL(req.url).searchParams.get('business_id')
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can view compensation settings.')

  const setting = await getCompensationSetting(ctx.businessIds[0])
  return NextResponse.json({ ok: true, setting })
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    business_id?: string
    commission_enabled?: boolean
    fixed_commission_per_delivered_order?: number
    large_bonus_alert_threshold?: number
    abnormal_penalty_alert_threshold?: number
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (!['SUPER_ADMIN', 'HR'].includes(ctx.role)) return forbidden('Only HR/Super Admin can update compensation settings.')

  const setting = await prisma.payrollCompensationSetting.upsert({
    where: { businessId: ctx.businessIds[0] },
    update: {
      commissionEnabled: body.commission_enabled,
      fixedCommissionPerDeliveredOrder: body.fixed_commission_per_delivered_order == null ? undefined : moneyDecimal(body.fixed_commission_per_delivered_order),
      largeBonusAlertThreshold: body.large_bonus_alert_threshold == null ? undefined : moneyDecimal(body.large_bonus_alert_threshold),
      abnormalPenaltyAlertThreshold: body.abnormal_penalty_alert_threshold == null ? undefined : moneyDecimal(body.abnormal_penalty_alert_threshold),
      updatedById: ctx.userId,
    },
    create: {
      businessId: ctx.businessIds[0],
      commissionEnabled: body.commission_enabled ?? true,
      fixedCommissionPerDeliveredOrder: moneyDecimal(body.fixed_commission_per_delivered_order || 0),
      largeBonusAlertThreshold: moneyDecimal(body.large_bonus_alert_threshold || 10000),
      abnormalPenaltyAlertThreshold: moneyDecimal(body.abnormal_penalty_alert_threshold || 5000),
      updatedById: ctx.userId,
    },
  })
  return NextResponse.json({ ok: true, setting })
}
