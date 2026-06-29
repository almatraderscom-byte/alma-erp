import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
import { computeWalletSummary, moneyDecimal } from '@/lib/payroll-wallet'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { apiFailure, apiDataSuccess } from '@/lib/safe-api-response'
import { logEvent } from '@/lib/logger'

/**
 * Staff acknowledges ("বুঝেছি") the daily outstanding-advance notice.
 * Records one ack per Asia/Dhaka day (idempotent) as proof the staff saw it.
 * The notice re-appears the next day and stays until the advance is fully recovered.
 */
export async function POST(req: NextRequest) {
  let body: { business_id?: string } = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const ctx = await getWalletContext(req, body.business_id)
  if ('error' in ctx) return ctx.error
  if (!ctx.employeeId) {
    return apiFailure('invalid_request', 'No employee profile linked to this account.', { status: 400 })
  }

  const businessId = resolveWalletScopeBusinessId(ctx.businessIds, body.business_id)
  const entries = await prisma.employeeLedgerEntry.findMany({
    where: { employeeId: ctx.employeeId, businessId, isArchived: false },
    select: { type: true, amount: true, date: true, periodYm: true },
  })
  const outstanding = computeWalletSummary(ctx.employeeId, businessId, entries).outstandingAdvance
  const ackDate = todayYmdDhaka()

  const ack = await prisma.advanceNoticeAck.upsert({
    where: { userId_businessId_ackDate: { userId: ctx.userId, businessId, ackDate } },
    update: { outstandingAtAck: moneyDecimal(outstanding) },
    create: {
      userId: ctx.userId,
      employeeId: ctx.employeeId,
      businessId,
      ackDate,
      outstandingAtAck: moneyDecimal(outstanding),
    },
  })

  logEvent('info', 'advance_notice.acknowledged', {
    userId: ctx.userId,
    employeeId: ctx.employeeId,
    businessId,
    ackDate,
    outstanding,
  })

  return apiDataSuccess({ acknowledged: true, ackDate, outstandingAtAck: outstanding, ackId: ack.id })
}
