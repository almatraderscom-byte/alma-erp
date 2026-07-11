import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden, resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
import { computeWalletSummary, runningTransactions } from '@/lib/payroll-wallet'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { walletEntryLabelBn } from '@/lib/wallet-labels'
import { buildFineSummaries, mapFineAppeals } from '@/lib/wallet-transparency'

function parseDateParam(raw: string | null, endOfDay = false): Date | null {
  if (!raw) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0))
  return Number.isNaN(d.getTime()) ? null : d
}

export async function GET(
  req: NextRequest,
  { params }: { params: { employeeId: string } },
) {
  const employeeId = decodeURIComponent(params.employeeId)
  const url = new URL(req.url)
  const businessId = url.searchParams.get('business_id')
  // Optional custom window (YYYY-MM-DD): filters the returned transaction list
  // and adds a matching customRange block to fineSummaries. Totals/balances are
  // always computed over the FULL history so the running balance stays true.
  const from = parseDateParam(url.searchParams.get('from'))
  const to = parseDateParam(url.searchParams.get('to'), true)
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
  const appeals = await mapFineAppeals(entries)
  const fineSummaries = buildFineSummaries(entries, appeals, { from, to })

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

  // Running balance over full history, then window-filter for display.
  const allTransactions = runningTransactions(entries).map(tx => ({
    ...tx,
    labelBn: walletEntryLabelBn(tx as { type: string; source?: string | null; periodYm?: string | null }),
    appeal: tx.type === 'PENALTY' ? appeals[String(tx.id)] ?? null : null,
  }))
  const windowed = from || to
    ? allTransactions.filter(tx => {
        const t = new Date(tx.date as string | Date).getTime()
        if (from && t < from.getTime()) return false
        if (to && t > to.getTime()) return false
        return true
      })
    : allTransactions

  return NextResponse.json({
    employeeId,
    businessId: scopedBusinessId,
    user: linkedUser
      ? { id: linkedUser.id, profileImageUrl: linkedUser.profileImageUrl, updatedAt: linkedUser.updatedAt }
      : null,
    summary,
    fineSummaries,
    range: { from: from?.toISOString() || null, to: to?.toISOString() || null },
    advanceNoticeAckedToday,
    entries: windowed,
    totalEntryCount: allTransactions.length,
    requests,
  })
}
