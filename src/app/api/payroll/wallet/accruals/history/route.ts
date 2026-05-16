import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'

export async function GET(req: NextRequest) {
  const businessId = new URL(req.url).searchParams.get('business_id')
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can view accrual history.')

  const runs = await prisma.payrollAccrualRun.findMany({
    where: { businessId: { in: ctx.businessIds } },
    orderBy: { createdAt: 'desc' },
    take: 36,
  })
  return NextResponse.json({ runs })
}
