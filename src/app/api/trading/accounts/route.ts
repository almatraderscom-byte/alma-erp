import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import { computePartnershipPreview } from '@/lib/trading-partnership'
import {
  TRADING_BUSINESS_ID,
  getTradingContext,
  isResponse,
  moneyDecimal,
  parseAccountType,
  parseTradingDate,
  positiveMoneyDecimal,
  rateDecimal,
  requireTradingAdmin,
  requireTradingSuperAdmin,
  requireTradingWrite,
  tradingAccountWhereForContext,
} from '@/lib/trading'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error

  const url = new URL(req.url)
  const search = url.searchParams.get('search')?.trim()
  const status = url.searchParams.get('status')?.trim().toUpperCase()

  const accounts = await prisma.tradingAccount.findMany({
    where: {
      ...tradingAccountWhereForContext(ctx),
      ...(status && status !== 'ALL' ? { status: status as never } : {}),
      ...(search
        ? {
            OR: [
              { accountTitle: { contains: search, mode: 'insensitive' } },
              { binanceUid: { contains: search, mode: 'insensitive' } },
              { assignedUser: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
    include: { assignedUser: { select: { id: true, name: true, email: true, role: true, employeeIdGas: true, salaryHint: true } } },
  })

  const partnershipIds = accounts.filter(a => a.partnershipEnabled).map(a => a.id)
  const partnershipHints = new Map<string, number>()
  if (partnershipIds.length > 0) {
    const previews = await Promise.all(partnershipIds.map(id => computePartnershipPreview(id).catch(() => null)))
    for (let i = 0; i < partnershipIds.length; i++) {
      const preview = previews[i]
      if (preview?.partnershipEnabled) partnershipHints.set(partnershipIds[i], preview.netStaffOwesBdt)
    }
  }

  const enriched = accounts.map(account => ({
    ...account,
    partnershipNetStaffOwes: partnershipHints.get(account.id) ?? null,
  }))

  return NextResponse.json({ accounts: enriched, total: enriched.length }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied
  const adminDenied = requireTradingAdmin(ctx)
  if (adminDenied) return adminDenied

  try {
    const body = (await req.json()) as {
      assignedUserId?: string
      accountTitle?: string
      binanceUid?: string
      accountType?: string
      startingCapital?: number
      merchantTarget?: number
      commissionType?: string
      commissionRate?: number
      fixedCommission?: number
      completionBonus?: number
      status?: string
      startDate?: string
      notes?: string
      partnershipEnabled?: boolean
      staffSharePercent?: number
    }

    const accountTitle = String(body.accountTitle || '').trim()
    if (!accountTitle) return NextResponse.json({ error: 'accountTitle is required' }, { status: 400 })

    const accountType = parseAccountType(body.accountType)
    if (isResponse(accountType)) return accountType
    const startingCapital = positiveMoneyDecimal(body.startingCapital, 'initialCapital')
    if (isResponse(startingCapital)) return startingCapital
    const startDate = parseTradingDate(body.startDate, 'startDate')
    if (isResponse(startDate)) return startDate

    const assignedUserId = String(body.assignedUserId || '').trim() || null
    if (assignedUserId) {
      const assigned = await prisma.user.findFirst({
        where: {
          id: assignedUserId,
          active: true,
          businessAccess: { contains: TRADING_BUSINESS_ID },
        },
        select: { id: true },
      })
      if (!assigned) {
        return NextResponse.json({ error: 'assignedUserId must be an active user with ALMA_TRADING access' }, { status: 400 })
      }
    }

    if (body.merchantTarget != null && body.merchantTarget !== undefined) {
      const superDenied = requireTradingSuperAdmin(ctx)
      if (superDenied) return superDenied
    }

    const account = await prisma.tradingAccount.create({
      data: {
        businessId: TRADING_BUSINESS_ID,
        assignedUserId,
        accountTitle,
        binanceUid: String(body.binanceUid || '').trim() || null,
        accountType,
        status: body.status === 'PAUSED' || body.status === 'COMPLETED' ? body.status : 'ACTIVE',
        startingCapital,
        currentBalance: startingCapital,
        merchantTarget: body.merchantTarget == null ? null : moneyDecimal(body.merchantTarget),
        commissionType: body.commissionType === 'PERCENTAGE' || body.commissionType === 'FIXED' ? body.commissionType : 'NONE',
        commissionRate: rateDecimal(body.commissionRate ?? 0),
        fixedCommission: moneyDecimal(body.fixedCommission ?? 0),
        completionBonus: moneyDecimal(body.completionBonus ?? 0),
        startDate,
        notes: String(body.notes || '').trim() || null,
        partnershipEnabled: Boolean(body.partnershipEnabled),
        staffSharePercent: rateDecimal(body.staffSharePercent ?? 50),
      },
    })

    logEvent('info', 'trading.account.created', {
      businessId: TRADING_BUSINESS_ID,
      accountId: account.id,
      actorUserId: ctx.userId,
      assignedUserId,
    })

    return NextResponse.json({ ok: true, account }, { status: 201 })
  } catch (e) {
    logEvent('error', 'trading.account.create_failed', { actorUserId: ctx.userId, error: (e as Error).message })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
