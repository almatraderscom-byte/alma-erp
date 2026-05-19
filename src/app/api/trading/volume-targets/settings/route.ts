import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  TRADING_BUSINESS_ID,
  getTradingContext,
  requireTradingSuperAdmin,
  requireTradingVolumeTargetView,
} from '@/lib/trading'
import { logEvent } from '@/lib/logger'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const viewDenied = requireTradingVolumeTargetView(ctx)
  if (viewDenied) return viewDenied

  const settings = await prisma.tradingVolumeTargetSettings.upsert({
    where: { businessId: TRADING_BUSINESS_ID },
    create: { businessId: TRADING_BUSINESS_ID },
    update: {},
  })

  return NextResponse.json({
    settings: {
      autoPenaltyEnabled: settings.autoPenaltyEnabled,
      defaultPenaltyBdt: Number(settings.defaultPenaltyBdt),
      updatedAt: settings.updatedAt.toISOString(),
    },
    canManage: ctx.isSuperAdmin,
  })
}

export async function PATCH(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingSuperAdmin(ctx)
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as {
    auto_penalty_enabled?: boolean
    default_penalty_bdt?: number
  }

  const settings = await prisma.tradingVolumeTargetSettings.upsert({
    where: { businessId: TRADING_BUSINESS_ID },
    create: {
      businessId: TRADING_BUSINESS_ID,
      autoPenaltyEnabled: Boolean(body.auto_penalty_enabled),
      defaultPenaltyBdt: new Prisma.Decimal(Number(body.default_penalty_bdt ?? 500).toFixed(2)),
      updatedById: ctx.userId,
    },
    update: {
      ...(body.auto_penalty_enabled !== undefined ? { autoPenaltyEnabled: Boolean(body.auto_penalty_enabled) } : {}),
      ...(body.default_penalty_bdt !== undefined
        ? { defaultPenaltyBdt: new Prisma.Decimal(Number(body.default_penalty_bdt).toFixed(2)) }
        : {}),
      updatedById: ctx.userId,
    },
  })

  logEvent('info', 'trading.volume_target.settings_updated', {
    businessId: TRADING_BUSINESS_ID,
    actorUserId: ctx.userId,
    autoPenaltyEnabled: settings.autoPenaltyEnabled,
    defaultPenaltyBdt: Number(settings.defaultPenaltyBdt),
  })

  return NextResponse.json({
    ok: true,
    settings: {
      autoPenaltyEnabled: settings.autoPenaltyEnabled,
      defaultPenaltyBdt: Number(settings.defaultPenaltyBdt),
    },
  })
}
