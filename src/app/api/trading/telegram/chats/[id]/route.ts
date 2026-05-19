import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID, getTradingContext, requireTradingAdmin } from '@/lib/trading'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingAdmin(ctx)
  if (denied) return denied

  const body = (await req.json()) as { approved?: boolean; title?: string; notes?: string }
  const existing = await prisma.tradingTelegramChat.findFirst({
    where: { id: params.id, businessId: TRADING_BUSINESS_ID },
  })
  if (!existing) return NextResponse.json({ error: 'Group not found' }, { status: 404 })

  const chat = await prisma.tradingTelegramChat.update({
    where: { id: existing.id },
    data: {
      approved: body.approved !== undefined ? Boolean(body.approved) : undefined,
      title: body.title !== undefined ? (body.title?.trim() || null) : undefined,
      notes: body.notes !== undefined ? (body.notes?.trim() || null) : undefined,
    },
  })

  return NextResponse.json({ ok: true, chat })
}
