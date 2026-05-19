import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getTradingContext, parseTradingDate, TRADING_BUSINESS_ID } from '@/lib/trading'

function money(value: unknown) {
  const n = Number(value || 0)
  return new Prisma.Decimal(Number.isFinite(n) ? n.toFixed(2) : '0')
}

function normalizeDate(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const params = new URL(req.url).searchParams
  const userId = params.get('userId') || params.get('user_id') || ''
  const limit = Math.min(100, Math.max(1, Number(params.get('limit') || 30)))
  const reports = await prisma.tradingEmployeeDailyReport.findMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      ...(ctx.isAdmin || ctx.role === 'HR' ? (userId ? { userId } : {}) : { userId: ctx.userId }),
    },
    include: {
      user: { select: { id: true, name: true, email: true, employeeIdGas: true } },
      employeeProfile: { select: { id: true, shift: true, roleTitle: true } },
    },
    orderBy: { reportDate: 'desc' },
    take: limit,
  })
  return NextResponse.json({ reports }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const body = await req.json()
  const targetUserId = String(body.userId || body.user_id || ctx.userId).trim()
  if (!ctx.isAdmin && ctx.role !== 'HR' && targetUserId !== ctx.userId) {
    return NextResponse.json({ error: 'Staff can only submit their own reports.' }, { status: 403 })
  }
  const targetUser = await prisma.user.findUnique({ where: { id: targetUserId }, select: { role: true } })
  if (targetUser?.role === 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'System owner accounts do not submit employee daily reports.' }, { status: 403 })
  }
  const reportDateRaw = parseTradingDate(body.reportDate || body.report_date || new Date(), 'reportDate')
  if (reportDateRaw instanceof NextResponse) return reportDateRaw
  const reportDate = normalizeDate(reportDateRaw)
  const accountIds = Array.isArray(body.accountIds) ? body.accountIds.map(String) : String(body.accountIds || body.account_ids || '').split(',').map(v => v.trim()).filter(Boolean)

  if (accountIds.length) {
    const count = await prisma.tradingAccount.count({
      where: {
        businessId: TRADING_BUSINESS_ID,
        id: { in: accountIds },
        deletedAt: null,
        ...(ctx.isAdmin || ctx.role === 'HR' ? {} : { assignedUserId: ctx.userId }),
      },
    })
    if (count !== accountIds.length) return NextResponse.json({ error: 'One or more accounts are not available to this employee.' }, { status: 400 })
  }

  const profile = await prisma.tradingEmployeeProfile.findUnique({ where: { userId: targetUserId }, select: { id: true } })
  const report = await prisma.tradingEmployeeDailyReport.upsert({
    where: { userId_reportDate: { userId: targetUserId, reportDate } },
    create: {
      businessId: TRADING_BUSINESS_ID,
      userId: targetUserId,
      employeeProfileId: profile?.id,
      reportDate,
      accountIds,
      totalTrades: Math.max(0, Number(body.totalTrades || body.total_trades || 0)),
      dailyProfitBdt: money(body.dailyProfitBdt || body.daily_profit_bdt || 0),
      dailyLossBdt: money(body.dailyLossBdt || body.daily_loss_bdt || 0),
      issues: String(body.issues || '').trim() || null,
      screenshotProof: String(body.screenshotProof || body.screenshot_proof || '').trim() || null,
      operationalNotes: String(body.operationalNotes || body.operational_notes || '').trim() || null,
    },
    update: {
      employeeProfileId: profile?.id,
      accountIds,
      totalTrades: Math.max(0, Number(body.totalTrades || body.total_trades || 0)),
      dailyProfitBdt: money(body.dailyProfitBdt || body.daily_profit_bdt || 0),
      dailyLossBdt: money(body.dailyLossBdt || body.daily_loss_bdt || 0),
      issues: String(body.issues || '').trim() || null,
      screenshotProof: String(body.screenshotProof || body.screenshot_proof || '').trim() || null,
      operationalNotes: String(body.operationalNotes || body.operational_notes || '').trim() || null,
      submittedAt: new Date(),
    },
  })
  await prisma.tradingEmployeeProfile.updateMany({
    where: { userId: targetUserId, businessId: TRADING_BUSINESS_ID },
    data: { lastActiveAt: new Date() },
  })
  return NextResponse.json({ ok: true, report })
}
