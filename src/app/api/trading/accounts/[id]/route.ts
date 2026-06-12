import { NextRequest, NextResponse } from 'next/server'
import type { TradingAccountStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { logEvent } from '@/lib/logger'
import {
  TRADING_BUSINESS_ID,
  getTradingContext,
  isResponse,
  moneyDecimal,
  nonNegativeMoneyDecimal,
  parseAccountType,
  parseTradingDate,
  rateDecimal,
  recalculateTradingAccount,
  requireTradingAdmin,
  requireTradingSuperAdmin,
  requireTradingWrite,
} from '@/lib/trading'

type RouteContext = { params: { id: string } }

const STATUSES = new Set(['ACTIVE', 'PAUSED', 'COMPLETED', 'CLOSED'])

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied
  const adminDenied = requireTradingAdmin(ctx)
  if (adminDenied) return adminDenied

  try {
    const body = (await req.json()) as {
      action?: 'update' | 'archive'
      assignedUserId?: string | null
      accountTitle?: string
      binanceUid?: string | null
      accountType?: string
      status?: string
      startingCapital?: number
      merchantTarget?: number | null
      commissionType?: string
      commissionRate?: number
      fixedCommission?: number
      completionBonus?: number
      startDate?: string
      completedDate?: string | null
      notes?: string | null
      partnershipEnabled?: boolean
      staffSharePercent?: number
    }

    const existing = await prisma.tradingAccount.findFirst({
      where: { id: params.id, businessId: TRADING_BUSINESS_ID, deletedAt: null },
      select: { id: true },
    })
    if (!existing) return NextResponse.json({ error: 'Trading account not found' }, { status: 404 })

    if (body.action === 'archive') {
      const account = await prisma.tradingAccount.update({
        where: { id: params.id },
        data: { deletedAt: new Date(), status: 'CLOSED' },
      })
      logEvent('info', 'trading.account.archived', { businessId: TRADING_BUSINESS_ID, accountId: params.id, actorUserId: ctx.userId })
      return NextResponse.json({ ok: true, account })
    }

    const data: Record<string, unknown> = {}
    if (body.accountTitle !== undefined) {
      const accountTitle = String(body.accountTitle || '').trim()
      if (!accountTitle) return NextResponse.json({ error: 'accountTitle is required' }, { status: 400 })
      data.accountTitle = accountTitle
    }
    if (body.binanceUid !== undefined) data.binanceUid = String(body.binanceUid || '').trim() || null
    if (body.accountType !== undefined) {
      const accountType = parseAccountType(body.accountType)
      if (isResponse(accountType)) return accountType
      data.accountType = accountType
    }
    if (body.status !== undefined) {
      const status = String(body.status || '').trim().toUpperCase()
      if (!STATUSES.has(status)) return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
      data.status = status as TradingAccountStatus
    }
    if (body.startingCapital !== undefined) {
      const startingCapital = nonNegativeMoneyDecimal(body.startingCapital, 'startingCapital')
      if (isResponse(startingCapital)) return startingCapital
      data.startingCapital = startingCapital
    }
    if (body.merchantTarget !== undefined) {
      const superDenied = requireTradingSuperAdmin(ctx)
      if (superDenied) return superDenied
      data.merchantTarget = body.merchantTarget == null ? null : moneyDecimal(body.merchantTarget)
    }
    if (body.commissionType !== undefined) {
      const commissionType = String(body.commissionType || 'NONE').trim().toUpperCase()
      if (!['NONE', 'PERCENTAGE', 'FIXED'].includes(commissionType)) return NextResponse.json({ error: 'Invalid commissionType' }, { status: 400 })
      data.commissionType = commissionType
    }
    if (body.commissionRate !== undefined) data.commissionRate = rateDecimal(body.commissionRate)
    if (body.fixedCommission !== undefined) data.fixedCommission = moneyDecimal(body.fixedCommission)
    if (body.completionBonus !== undefined) data.completionBonus = moneyDecimal(body.completionBonus)
    if (body.startDate !== undefined) {
      const startDate = parseTradingDate(body.startDate, 'startDate')
      if (isResponse(startDate)) return startDate
      data.startDate = startDate
    }
    if (body.completedDate !== undefined) {
      data.completedDate = body.completedDate ? new Date(body.completedDate) : null
    }
    if (body.notes !== undefined) data.notes = String(body.notes || '').trim() || null
    if (body.assignedUserId !== undefined) {
      const assignedUserId = String(body.assignedUserId || '').trim() || null
      if (assignedUserId) {
        const assigned = await prisma.user.findFirst({
          where: { id: assignedUserId, active: true, businessAccess: { contains: TRADING_BUSINESS_ID } },
          select: { id: true },
        })
        if (!assigned) return NextResponse.json({ error: 'assignedUserId must be an active user with ALMA_TRADING access' }, { status: 400 })
      }
      data.assignedUserId = assignedUserId
    }
    if (body.partnershipEnabled !== undefined) data.partnershipEnabled = Boolean(body.partnershipEnabled)
    if (body.staffSharePercent !== undefined) {
      const pct = Number(body.staffSharePercent)
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        return NextResponse.json({ error: 'staffSharePercent must be between 0 and 100' }, { status: 400 })
      }
      data.staffSharePercent = rateDecimal(pct)
    }

    const account = await prisma.$transaction(async tx => {
      await tx.tradingAccount.update({ where: { id: params.id }, data })
      await recalculateTradingAccount(tx, params.id)
      return tx.tradingAccount.findUniqueOrThrow({ where: { id: params.id } })
    })
    logEvent('info', 'trading.account.updated', { businessId: TRADING_BUSINESS_ID, accountId: params.id, actorUserId: ctx.userId })
    return NextResponse.json({ ok: true, account })
  } catch (e) {
    logEvent('error', 'trading.account.update_failed', { actorUserId: ctx.userId, accountId: params.id, error: (e as Error).message })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
