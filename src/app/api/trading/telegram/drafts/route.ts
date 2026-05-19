import { NextRequest, NextResponse } from 'next/server'
import type { TradingTelegramDraftStatus } from '@prisma/client'
import { getTradingContext } from '@/lib/trading'
import { canUseTelegramDraftReview } from '@/lib/trading-telegram-permissions'
import { listTelegramDrafts } from '@/lib/trading-telegram-drafts'
import { groupDraftsByDayAndAccount, groupDraftsByUserAndAccount } from '@/lib/trading-telegram-user-ops'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  if (!canUseTelegramDraftReview(ctx)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const statusParam = (url.searchParams.get('status') || 'PENDING') as TradingTelegramDraftStatus | 'ALL'
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 100)
  const grouped = url.searchParams.get('grouped') === '1'
  const byDay = url.searchParams.get('byDay') === '1'
  const userId = ctx.isAdmin ? (url.searchParams.get('userId') || undefined) : undefined
  const tradingAccountId = url.searchParams.get('tradingAccountId') || undefined
  const duplicateOnly = url.searchParams.get('duplicateOnly') === '1'

  const drafts = await listTelegramDrafts({
    status: statusParam,
    limit,
    userId,
    tradingAccountId,
    duplicateOnly,
    ctx,
  })

  if (byDay) {
    return NextResponse.json({
      drafts,
      dayGroups: groupDraftsByDayAndAccount(drafts),
    })
  }

  if (grouped) {
    return NextResponse.json({
      drafts,
      groups: groupDraftsByUserAndAccount(drafts),
    })
  }

  return NextResponse.json({ drafts })
}
