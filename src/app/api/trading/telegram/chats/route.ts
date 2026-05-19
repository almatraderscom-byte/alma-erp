import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID, getTradingContext, requireTradingAdmin } from '@/lib/trading'
import { normalizeTelegramChatId, telegramChatIdLookupVariants } from '@/lib/trading-telegram-chat'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingAdmin(ctx)
  if (denied) return denied

  const chats = await prisma.tradingTelegramChat.findMany({
    where: { businessId: TRADING_BUSINESS_ID },
    orderBy: [{ approved: 'desc' }, { updatedAt: 'desc' }],
  })
  return NextResponse.json({ chats })
}

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingAdmin(ctx)
  if (denied) return denied

  const body = (await req.json()) as { chatId?: string; title?: string; approved?: boolean; notes?: string }
  const rawChatId = String(body.chatId || '').trim()
  if (!rawChatId) return NextResponse.json({ error: 'chatId required' }, { status: 400 })

  const chatId = normalizeTelegramChatId(rawChatId)
  if (!/^-?\d+$/.test(chatId)) {
    return NextResponse.json({
      error: 'Chat ID must be numeric (groups use a negative ID like -1001234567890)',
    }, { status: 400 })
  }

  // Merge legacy row saved without minus sign.
  const variants = telegramChatIdLookupVariants(chatId)
  const legacy = await prisma.tradingTelegramChat.findFirst({
    where: { businessId: TRADING_BUSINESS_ID, chatId: { in: variants } },
  })

  const chat = legacy
    ? await prisma.tradingTelegramChat.update({
        where: { id: legacy.id },
        data: {
          chatId,
          title: body.title?.trim() || legacy.title,
          approved: body.approved !== undefined ? Boolean(body.approved) : true,
          notes: body.notes?.trim() || legacy.notes,
        },
      })
    : await prisma.tradingTelegramChat.create({
        data: {
          businessId: TRADING_BUSINESS_ID,
          chatId,
          title: body.title?.trim() || null,
          approved: body.approved !== false,
          notes: body.notes?.trim() || null,
        },
      })

  const normalizedFromInput = rawChatId !== chatId

  return NextResponse.json(
    {
      ok: true,
      chat,
      normalized: normalizedFromInput,
      message: normalizedFromInput
        ? `Saved as ${chatId} (leading minus added for group chat)`
        : undefined,
    },
    { status: legacy ? 200 : 201 },
  )
}
