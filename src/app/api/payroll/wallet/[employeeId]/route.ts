import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden, resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
import { computeWalletSummary, runningTransactions } from '@/lib/payroll-wallet'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

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

  const linkedUser = await prisma.user.findFirst({
    where: { employeeIdGas: employeeId },
    select: { id: true, profileImageUrl: true, updatedAt: true },
  })

  const summary = computeWalletSummary(employeeId, scopedBusinessId, entries)

  // Daily "outstanding advance" notice: shown once per Asia/Dhaka day until acknowledged.
  // Re-appears each day (and stays) until the advance is fully recovered from salary.
  let advanceNoticeAckedToday = false
  if (summary.outstandingAdvance > 0 && linkedUser?.id) {
    const ack = await prisma.advanceNoticeAck.findUnique({
      where: {
        userId_businessId_ackDate: {
          userId: linkedUser.id,
          businessId: scopedBusinessId,
          ackDate: todayYmdDhaka(),
        },
      },
      select: { id: true },
    })
    advanceNoticeAckedToday = Boolean(ack)
  }

  return NextResponse.json({
    employeeId,
    businessId: scopedBusinessId,
    user: linkedUser
      ? { id: linkedUser.id, profileImageUrl: linkedUser.profileImageUrl, updatedAt: linkedUser.updatedAt }
      : null,
    summary,
    advanceNoticeAckedToday,
    entries: runningTransactions(entries),
    requests,
  })
}
