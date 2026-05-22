import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { resolveBusinessId } from '@/lib/businesses'
import { getTelegramOpsDashboard } from '@/lib/telegram-notification/ops-health'
import {
  getTelegramQueueHealth,
  processTelegramNotificationQueue,
  reclaimStuckTelegramSendingRows,
} from '@/lib/telegram-notification/queue'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const businessId = resolveBusinessId(req.nextUrl.searchParams.get('business_id'))
  const dashboard = await getTelegramOpsDashboard(businessId)
  return NextResponse.json({ ok: true, ...dashboard })
}

/** Reclaim stuck SENDING rows and process up to 25 queued notifications. */
export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const businessId = resolveBusinessId(req.nextUrl.searchParams.get('business_id'))
  const started = Date.now()
  const reclaimed = await reclaimStuckTelegramSendingRows()
  const processed = await processTelegramNotificationQueue({ limit: 30, businessId })
  const queue = await getTelegramQueueHealth(businessId)

  return NextResponse.json({
    ok: true,
    reclaimed,
    processed,
    queue,
    durationMs: Date.now() - started,
    flushedAt: new Date().toISOString(),
    businessId,
  })
}
