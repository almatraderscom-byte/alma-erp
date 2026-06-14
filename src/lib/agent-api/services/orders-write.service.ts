import { dispatchUpdateOrderField, dispatchUpdateOrderStatus } from '@/lib/lifestyle/write-dispatch'
import { agentActorPayload } from '@/lib/agent-api/route-handler'
import { getAgentOrderDetail, listAgentOrders } from '@/lib/agent-api/orders.service'

export async function cancelOrder(id: string, reason: string) {
  const before = await getAgentOrderDetail(id)
  if (!before) return null
  await dispatchUpdateOrderStatus(
    agentActorPayload({ id, status: 'CANCELLED', previous_status: before.status, reason }),
  )
  return { id, status: 'cancelled', reason }
}

export async function refundOrder(id: string, body: { full?: boolean; amount?: number; reason: string }) {
  const status = body.full ? 'RETURNED_PAID' : 'RETURNED'
  await dispatchUpdateOrderStatus(
    agentActorPayload({
      id,
      status,
      reason: body.reason,
      refund_amount: body.amount,
    }),
  )
  return { id, status: 'refunded', full: body.full ?? false, amount: body.amount ?? null }
}

export async function patchOrderStatus(id: string, status: string, reason?: string) {
  const before = await getAgentOrderDetail(id)
  if (!before) return null
  const almaStatus = mapAgentToAlma(status)
  await dispatchUpdateOrderStatus(
    agentActorPayload({ id, status: almaStatus, previous_status: before.status, reason }),
  )
  return { id, status: status.toLowerCase() }
}

export async function addOrderNote(id: string, note: string) {
  await dispatchUpdateOrderField(agentActorPayload({ id, field: 'notes', value: note }))
  return { id, status: 'note_added' }
}

export async function listTodayLiveOrders() {
  const { orders } = await listAgentOrders({ limit: 100, startDate: new Date().toISOString().slice(0, 10) })
  return { orders, meta: { count: orders.length, live: true, generatedAt: new Date().toISOString() } }
}

function mapAgentToAlma(status: string): string {
  const s = status.toLowerCase()
  const map: Record<string, string> = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    processing: 'Packed',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'CANCELLED',
    refunded: 'RETURNED',
  }
  return map[s] ?? status
}
