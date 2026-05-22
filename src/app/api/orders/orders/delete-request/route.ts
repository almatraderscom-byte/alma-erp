import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { createApprovalRequest } from '@/lib/approvals'
import { APPROVAL_MODULES, APPROVAL_TYPES } from '@/lib/approval-types'
import { canRequestOrderDelete, orderSnapshotForApproval } from '@/lib/order-access'
import { normalizeAlmaRole } from '@/lib/roles'
import { serverGet } from '@/lib/server-api'
import type { Order } from '@/types'
import { prisma } from '@/lib/prisma'
import { getArchivedRegistryIds } from '@/lib/business-archive/registry-filter'

export async function POST(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const role = normalizeAlmaRole(token.role as string)
  if (!canRequestOrderDelete(role)) {
    return NextResponse.json({ error: 'You cannot request order deletion.' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    order_id?: string
    business_id?: string
    reason?: string
  }
  const orderId = String(body.order_id || '').trim()
  const businessId = String(body.business_id || 'ALMA_LIFESTYLE').trim()
  const reason = String(body.reason || '').trim()
  if (!orderId || reason.length < 5) {
    return NextResponse.json({ error: 'order_id and reason (min 5 chars) required' }, { status: 400 })
  }

  const archived = await getArchivedRegistryIds(businessId, 'orders')
  if (archived.has(orderId)) {
    return NextResponse.json({ error: 'Order is already removed from the active list.' }, { status: 409 })
  }

  const pending = await prisma.approvalRequest.findFirst({
    where: {
      module: APPROVAL_MODULES.ORDERS_CRM,
      type: APPROVAL_TYPES.ORDER_DELETE,
      entityId: orderId,
      status: 'PENDING',
    },
    select: { id: true },
  })
  if (pending) {
    return NextResponse.json({
      ok: true,
      duplicate: true,
      approvalId: pending.id,
      message: 'A delete request for this order is already pending Super Admin approval.',
    })
  }

  let order: Order
  try {
    const data = await serverGet<{ order?: Order } | Order>('order', { id: orderId, business_id: businessId }, 0)
    order = ('order' in (data as object) ? (data as { order?: Order }).order : data) as Order
    if (!order?.id) throw new Error('Order not found')
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Order not found' }, { status: 404 })
  }

  const approval = await createApprovalRequest({
    module: APPROVAL_MODULES.ORDERS_CRM,
    type: APPROVAL_TYPES.ORDER_DELETE,
    businessId,
    entityId: orderId,
    requestedBy: token.sub,
    reason,
    priority: 'HIGH',
    actionUrl: '/orders',
    title: 'Order delete approval required',
    message: `Delete requested for order ${orderId} (${order.customer}). Reason: ${reason}`,
    payloadSnapshot: {
      order: orderSnapshotForApproval(order),
      requestedByName: String(token.name || token.email || 'User'),
    },
  })

  return NextResponse.json({
    ok: true,
    approvalId: approval.id,
    message: 'Delete request submitted. A Super Admin must approve it in Approvals.',
  })
}
