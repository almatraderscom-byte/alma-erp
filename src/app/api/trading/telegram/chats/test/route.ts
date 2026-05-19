import { NextRequest, NextResponse } from 'next/server'
import { getTradingContext, requireTradingAdmin } from '@/lib/trading'
import { findApprovedTelegramChat, normalizeTelegramChatId } from '@/lib/trading-telegram-chat'
import { sendTelegramMessage } from '@/lib/trading-telegram-bot'

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingAdmin(ctx)
  if (denied) return denied

  const body = (await req.json()) as { chatId?: string; rowId?: string }
  const incoming = String(body.chatId || '').trim()
  if (!incoming) return NextResponse.json({ error: 'chatId required' }, { status: 400 })

  const normalized = normalizeTelegramChatId(incoming)
  const row = await findApprovedTelegramChat(normalized)
  if (!row) {
    return NextResponse.json(
      {
        error: 'Group not found or not approved',
        normalizedChatId: normalized,
        hint: 'Use the exact ID from the bot reply (usually starts with -100 or -)',
      },
      { status: 404 },
    )
  }

  const sent = await sendTelegramMessage(
    row.chatId,
    '✅ <b>Alma ERP connection test</b>\nThis group is registered and approved.',
    { replyMarkup: { remove_keyboard: true } },
  )

  if (!sent.ok) {
    return NextResponse.json(
      {
        error: 'Telegram did not accept the test message. Is the bot still in this group?',
        storedChatId: row.chatId,
      },
      { status: 502 },
    )
  }

  return NextResponse.json({
    ok: true,
    storedChatId: row.chatId,
    approved: row.approved,
    title: row.title,
  })
}
