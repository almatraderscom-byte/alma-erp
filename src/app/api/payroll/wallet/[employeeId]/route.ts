import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { computeWalletSummary, runningTransactions } from '@/lib/payroll-wallet'

export async function GET(
  req: NextRequest,
  { params }: { params: { employeeId: string } },
) {
  const employeeId = decodeURIComponent(params.employeeId)
  const businessId = new URL(req.url).searchParams.get('business_id')
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx) return ctx.error

  if (!ctx.isAdmin && employeeId !== ctx.employeeId) {
    return forbidden('Employees can only view their own wallet.')
  }

  const entries = await prisma.employeeLedgerEntry.findMany({
    where: { employeeId, businessId: { in: ctx.businessIds } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  })
  const requests = await prisma.walletRequest.findMany({
    where: { employeeId, businessId: { in: ctx.businessIds } },
    orderBy: { createdAt: 'desc' },
  })

  const primaryBusiness = businessId || entries[0]?.businessId || ctx.businessIds[0]
  return NextResponse.json({
    employeeId,
    businessId: primaryBusiness,
    summary: computeWalletSummary(employeeId, primaryBusiness, entries.filter(e => e.businessId === primaryBusiness)),
    entries: runningTransactions(entries),
    requests,
  })
}
