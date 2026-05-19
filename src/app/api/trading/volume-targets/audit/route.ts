import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID, getTradingContext, requireTradingSuperAdmin } from '@/lib/trading'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingSuperAdmin(ctx)
  if (denied) return denied

  const url = new URL(req.url)
  const targetId = url.searchParams.get('targetId') || undefined
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)))

  const rows = await prisma.tradingVolumeTargetAudit.findMany({
    where: {
      businessId: TRADING_BUSINESS_ID,
      ...(targetId ? { targetId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  return NextResponse.json({
    audits: rows.map(r => ({
      id: r.id,
      targetId: r.targetId,
      action: r.action,
      actorUserId: r.actorUserId,
      detail: r.detail,
      metadataJson: r.metadataJson,
      createdAt: r.createdAt.toISOString(),
    })),
  })
}
