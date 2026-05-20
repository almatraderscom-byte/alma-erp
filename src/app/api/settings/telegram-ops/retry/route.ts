import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { resolveBusinessId } from '@/lib/businesses'
import { retryAllFailedTelegramNotifications, retryTelegramNotification } from '@/lib/telegram-notification/queue'
import { apiFailure, apiSuccess } from '@/lib/safe-api-response'

export async function POST(req: NextRequest) {
  try {
    const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
    if (denied) return denied

    const body = (await req.json().catch(() => ({}))) as { id?: string; retry_all?: boolean; business_id?: string }

    if (body.retry_all) {
      const businessId = body.business_id ? resolveBusinessId(body.business_id) : undefined
      const result = await retryAllFailedTelegramNotifications(businessId, 50)
      return apiSuccess(result)
    }

    if (!body.id) return apiFailure('invalid_request', 'Queue id or retry_all required', { status: 400 })

    const result = await retryTelegramNotification(body.id)
    return apiSuccess({ result })
  } catch (e) {
    return apiFailure('telegram_retry_failed', (e as Error).message, { status: 500 })
  }
}
