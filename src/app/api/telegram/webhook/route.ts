import { NextRequest, NextResponse } from 'next/server'
import { logEvent } from '@/lib/logger'
import { handleTelegramUpdate } from '@/lib/trading-telegram-service'
import type { TelegramUpdate } from '@/lib/trading-telegram-types'

export const runtime = 'nodejs'
export const maxDuration = 30

function verifyWebhookSecret(req: NextRequest): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!expected) return process.env.NODE_ENV !== 'production'
  const header = req.headers.get('x-telegram-bot-api-secret-token')
  return header === expected
}

export async function POST(req: NextRequest) {
  if (!verifyWebhookSecret(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const update = (await req.json()) as TelegramUpdate
    await handleTelegramUpdate(update)
    return NextResponse.json({ ok: true })
  } catch (e) {
    logEvent('error', 'trading.telegram.webhook_failed', {
      error: (e as Error).message,
    })
    return NextResponse.json({ ok: true })
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'alma-trading-telegram',
    autoPost: process.env.TELEGRAM_AUTO_POST_TRADES === 'true',
  })
}
