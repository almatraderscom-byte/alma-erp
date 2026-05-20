import { NextRequest } from 'next/server'
import { resolveBusinessId } from '@/lib/businesses'
import { sendTelegramOwnerTestNotification } from '@/lib/telegram-notification/send-test'
import { withApiRoute, apiDataSuccess, apiFailure, requireJwtRoles, parseJsonBody } from '@/lib/core/safe-route-helpers'

export const dynamic = 'force-dynamic'

export const POST = withApiRoute('telegram.ops.test', async (req: NextRequest) => {
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (!auth.ok) return auth.response

  const body = await parseJsonBody<{ business_id?: string }>(req)
  const businessId = resolveBusinessId(body.business_id || req.nextUrl.searchParams.get('business_id'))
  const result = await sendTelegramOwnerTestNotification(businessId, String(auth.token.sub))
  if (!result.ok) {
    return apiFailure('telegram_test_failed', result.error || 'Test notification failed', { status: 400, extra: result as Record<string, unknown> })
  }
  return apiDataSuccess(result as Record<string, unknown>)
})
