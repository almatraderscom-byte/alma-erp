/**
 * Freeze-safe Telegram staff mapping soft-unlink.
 *
 * Soft delete only — we do NOT remove the TradingTelegramUser row. Instead
 * we clear the ERP linkage (userId=null, approved=false, defaults cleared).
 * Every hot path filters `approved: true` and/or `userId: { not: null }`, so
 * the soft-unlinked row becomes invisible to:
 *   - webhook ingestion (`trading-telegram-service.ts` upserts but never
 *     approves automatically)
 *   - trade draft processor (`telegram-approval-actor.ts` resolveActor)
 *   - trading volume callback (`trading-volume-target-callback.ts`)
 *   - chat router
 *
 * The row is preserved so that:
 *   - historical drafts/messages remain linked by `telegramUserId`
 *   - re-link is a single POST upsert (existing route, no admin retraining)
 *
 * This is a minimal freeze-safe hotfix. Schema is untouched. No queue,
 * webhook, ingestion, or approval code is modified.
 */
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getTradingContext, TRADING_BUSINESS_ID } from '@/lib/trading'
import { withApiRoute, apiDataSuccess, apiFailure } from '@/lib/core/safe-route-helpers'
import { logEvent } from '@/lib/logger'

export const DELETE = withApiRoute(
  'trading.telegram.users.remove',
  async (req: NextRequest, ctx?: unknown) => {
    const { params } = (ctx as { params: { id: string } } | undefined) || { params: { id: '' } }
    const id = String(params?.id || '').trim()
    if (!id) {
      return apiFailure('invalid_request', 'Telegram user id required', { status: 400 })
    }

    const tctx = await getTradingContext(req)
    if ('error' in tctx) return tctx.error
    if (!tctx.isSuperAdmin) {
      return apiFailure('forbidden', 'Only Super Admin can remove Telegram staff mappings.', {
        status: 403,
      })
    }

    const row = await prisma.tradingTelegramUser.findFirst({
      where: { id, businessId: TRADING_BUSINESS_ID },
      select: {
        id: true,
        userId: true,
        approved: true,
        telegramUserId: true,
        defaultTradingAccountId: true,
        defaultAccountAlias: true,
      },
    })
    if (!row) {
      return apiFailure('not_found', 'Telegram mapping not found', { status: 404 })
    }

    // Idempotent: already unlinked → return success without rewriting the row.
    if (row.userId === null && row.approved === false) {
      logEvent('info', 'trading.telegram.users.remove.idempotent', {
        id: row.id,
        telegramUserId: row.telegramUserId,
        adminId: tctx.userId,
      })
      return apiDataSuccess({
        ok: true,
        removed: true,
        id: row.id,
        idempotentReplay: true,
      })
    }

    await prisma.tradingTelegramUser.update({
      where: { id: row.id },
      data: {
        userId: null,
        approved: false,
        defaultTradingAccountId: null,
        defaultAccountAlias: null,
      },
    })

    logEvent('info', 'trading.telegram.users.remove.unlinked', {
      id: row.id,
      telegramUserId: row.telegramUserId,
      previouslyLinkedUserId: row.userId,
      previouslyApproved: row.approved,
      adminId: tctx.userId,
    })

    return apiDataSuccess({
      ok: true,
      removed: true,
      id: row.id,
      idempotentReplay: false,
    })
  },
)
