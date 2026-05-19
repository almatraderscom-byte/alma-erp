import { NextRequest, NextResponse } from 'next/server'
import { getTradingContext } from '@/lib/trading'
import { getTelegramLiveFeed } from '@/lib/trading-telegram-live'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error

  if (!ctx.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const url = new URL(req.url)
  const sinceParam = url.searchParams.get('since')
  const since = sinceParam ? new Date(sinceParam) : undefined
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 40), 1), 60)

  const feed = await getTelegramLiveFeed({ since: since && !Number.isNaN(since.getTime()) ? since : undefined, limit })

  return NextResponse.json(feed)
}
