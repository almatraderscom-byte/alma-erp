import { NextRequest, NextResponse } from 'next/server'
import { canUseTelegramDraftReview } from '@/lib/trading-telegram-permissions'
import { getTradingContext, requireTradingWrite } from '@/lib/trading'
import { bulkApproveTelegramDrafts, bulkRejectTelegramDrafts } from '@/lib/trading-telegram-drafts'

export async function POST(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const writeDenied = requireTradingWrite(ctx)
  if (writeDenied) return writeDenied
  if (!canUseTelegramDraftReview(ctx)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json()) as {
    draftIds?: string[]
    action?: 'approve' | 'reject'
    reason?: string
  }
  const draftIds = Array.isArray(body.draftIds) ? body.draftIds.filter(Boolean) : []
  if (!draftIds.length) {
    return NextResponse.json({ error: 'draftIds array required' }, { status: 400 })
  }

  const action = body.action === 'reject' ? 'reject' : 'approve'

  if (action === 'reject') {
    const results = await bulkRejectTelegramDrafts(ctx, draftIds, String(body.reason || 'Bulk rejected'))
    const ok = results.filter(r => r.ok).length
    const failed = results.filter(r => !r.ok).length
    return NextResponse.json({ ok: true, rejected: ok, failed, results })
  }

  const results = await bulkApproveTelegramDrafts(ctx, draftIds)
  const ok = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length

  return NextResponse.json({ ok: true, posted: ok, failed, results })
}
