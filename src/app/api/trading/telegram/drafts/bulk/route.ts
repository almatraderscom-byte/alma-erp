import { NextRequest, NextResponse } from 'next/server'
import { canUseTelegramDraftReview } from '@/lib/trading-telegram-permissions'
import { getTradingContext, requireTradingWrite } from '@/lib/trading'
import {
  bulkApproveTelegramDrafts,
  bulkRejectTelegramDrafts,
  MAX_BULK_CONFIRM,
} from '@/lib/trading-telegram-drafts'

// Each confirm is a transaction plus an account recalc and a snapshot refresh.
// A staffer clearing a day's backlog in one press needs more than the default.
export const runtime = 'nodejs'
export const maxDuration = 120

/** Distinct failure messages, newest-first order preserved, capped for a toast. */
function distinctReasons(results: Array<{ ok: boolean; error?: string }>): string[] {
  const seen = new Set<string>()
  for (const r of results) {
    if (r.ok || !r.error) continue
    seen.add(r.error)
    if (seen.size >= 3) break
  }
  return [...seen]
}

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
    return NextResponse.json({
      ok: true,
      rejected: ok,
      failed,
      failureReasons: distinctReasons(results),
      results,
    })
  }

  const { results, skipped } = await bulkApproveTelegramDrafts(ctx, draftIds)
  const ok = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length

  // "Failed: 2" with no reason left the owner guessing which draft and why.
  // `skipped` covers a batch larger than MAX_BULK_CONFIRM or one that ran out of
  // time — those drafts are untouched, so pressing again finishes the job.
  return NextResponse.json({
    ok: true,
    posted: ok,
    failed,
    skipped,
    maxPerBatch: MAX_BULK_CONFIRM,
    failureReasons: distinctReasons(results),
    results,
  })
}
