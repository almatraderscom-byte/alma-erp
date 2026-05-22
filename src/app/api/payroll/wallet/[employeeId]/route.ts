import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden, resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
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

  const scopedBusinessId = resolveWalletScopeBusinessId(ctx.businessIds, businessId)

  const entries = await prisma.employeeLedgerEntry.findMany({
    where: {
      employeeId,
      businessId: scopedBusinessId,
      isArchived: false,
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  })
  const requests = await prisma.walletRequest.findMany({
    where: {
      employeeId,
      businessId: scopedBusinessId,
      isArchived: false,
    },
    orderBy: { createdAt: 'desc' },
  })

  return NextResponse.json({
    employeeId,
    businessId: scopedBusinessId,
    summary: computeWalletSummary(employeeId, scopedBusinessId, entries),
    entries: runningTransactions(entries),
    requests,
  })
}
