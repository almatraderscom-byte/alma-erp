import { NextRequest, NextResponse } from 'next/server'
import { getTradingContext, requireTradingAdmin } from '@/lib/trading'
import { getTelegramWebhookInfo, registerTelegramWebhook } from '@/lib/trading-telegram-bot'

/** Prefer deployment host (preview + prod); fall back to configured public URL. */
function appBaseUrl() {
  if (process.env.VERCEL_URL) {
    const host = process.env.VERCEL_URL.replace(/\/$/, '')
    return host.startsWith('http') ? host : `https://${host}`
  }
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app'
  return base.startsWith('http') ? base.replace(/\/$/, '') : `https://${base}`
}

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingAdmin(ctx)
  if (denied) return denied

  try {
    const info = await getTelegramWebhookInfo()
    const webhookUrl = `${appBaseUrl()}/api/telegram/webhook`
    return NextResponse.json({
      ok: true,
      configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      webhookUrl,
      secretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      telegram: info.result ?? null,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const denied = requireTradingAdmin(ctx)
  if (denied) return denied

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({
      error: 'Set TELEGRAM_WEBHOOK_SECRET in environment before registering webhook',
    }, { status: 400 })
  }

  try {
    const webhookUrl = `${appBaseUrl()}/api/telegram/webhook`
    await registerTelegramWebhook(webhookUrl, secret)
    const info = await getTelegramWebhookInfo()
    return NextResponse.json({ ok: true, webhookUrl, telegram: info.result ?? null })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
