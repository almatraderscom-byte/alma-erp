import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { apiFailure } from '@/lib/safe-api-response'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { logEvent } from '@/lib/logger'
import {
  applyOrderStatusChange,
  normalizeOrderStatus,
  VALID_ORDER_STATUSES,
} from '@/lib/lifestyle/order-status-workflow'

export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied
  try {
    const { id, status, reason } = await req.json()
    if (!id || !status) return NextResponse.json({ error: 'id and status required' }, { status: 400 })
    const nextStatus = normalizeOrderStatus(String(status))
    if (!VALID_ORDER_STATUSES.has(nextStatus)) {
      return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 })
    }

    // The actor is resolved here because it needs the request. Everything the
    // status change ENTAILS — commission, courier SMS, notifications, the log
    // line — moved into the shared workflow, so the agent's approval path
    // cannot skip what this route always did.
    const actorPayload = await mergeActorPayload(req, { id, status: nextStatus })
    const outcome = await applyOrderStatusChange({
      id: String(id),
      status: nextStatus,
      reason: String(reason || ''),
      extraPayload: actorPayload,
    })

    if (!outcome.ok) {
      const httpStatus = outcome.code === 'not_found' ? 404 : outcome.code === 'terminal' ? 409 : 400
      return NextResponse.json({ error: outcome.error }, { status: httpStatus })
    }

    return NextResponse.json({
      ...(outcome.result as Record<string, unknown>),
      commission: outcome.commission,
    })
  } catch (e) {
    logEvent('error', 'orders.status_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not update order status.', { status: 500 })
  }
}
