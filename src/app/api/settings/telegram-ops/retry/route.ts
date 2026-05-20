import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { resolveBusinessId } from '@/lib/businesses'
import { retryAllFailedTelegramNotifications, retryTelegramNotification } from '@/lib/telegram-notification/queue'
import { apiDataSuccess, apiFailure } from '@/lib/safe-api-response'
import { withApiRoute } from '@/lib/core/safe-route-helpers'

export const POST = withApiRoute('telegram.ops.retry', async (req: NextRequest) => {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as { id?: string; retry_all?: boolean; business_id?: string }

  if (body.retry_all) {
    const businessId = body.business_id ? resolveBusinessId(body.business_id) : undefined
    const result = await retryAllFailedTelegramNotifications(businessId, 50)
    return apiDataSuccess(result as Record<string, unknown>)
  }

  if (!body.id) return apiFailure('invalid_request', 'Queue id or retry_all required', { status: 400 })

  const result = await retryTelegramNotification(body.id)
  return apiDataSuccess({ result })
})
