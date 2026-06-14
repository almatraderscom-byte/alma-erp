import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { mergeActorPayload } from '@/lib/api-route-actor'
import {
  canEditOrder,
  ORDER_EDITABLE_FIELDS,
  orderFieldToGas,
  type OrderEditableField,
} from '@/lib/order-access'
import { normalizeAlmaRole } from '@/lib/roles'
import { fetchOrderById } from '@/lib/lifestyle/read'
import { dispatchUpdateOrderField } from '@/lib/lifestyle/write-dispatch'
import type { Order } from '@/types'

export async function POST(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    order_id?: string
    business_id?: string
    fields?: Record<string, unknown>
  }
  const orderId = String(body.order_id || '').trim()
  const businessId = String(body.business_id || 'ALMA_LIFESTYLE').trim()
  const fields = body.fields && typeof body.fields === 'object' ? body.fields : null
  if (!orderId || !fields || !Object.keys(fields).length) {
    return NextResponse.json({ error: 'order_id and fields required' }, { status: 400 })
  }

  let order: Order
  try {
    const found = await fetchOrderById(orderId, businessId)
    if (!found?.id) throw new Error('Order not found')
    order = found
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'Order not found' }, { status: 404 })
  }

  const role = normalizeAlmaRole(token.role as string)
  if (!canEditOrder(role, token.sub, order)) {
    return NextResponse.json({ error: 'You cannot edit this order. Ask an admin or request delete instead.' }, { status: 403 })
  }

  const updates: Array<{ field: string; value: string | number }> = []
  for (const key of ORDER_EDITABLE_FIELDS) {
    if (!(key in fields)) continue
    const gasField = orderFieldToGas(key)
    if (!gasField) continue
    const raw = fields[key as OrderEditableField]
    if (raw === undefined || raw === null) continue
    if (key === 'qty') {
      const qty = Number(raw)
      if (!Number.isFinite(qty) || qty <= 0) {
        return NextResponse.json({ error: 'qty must be a positive number' }, { status: 400 })
      }
      updates.push({ field: gasField, value: qty })
      continue
    }
    if (key === 'unit_price' || key === 'discount') {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: `${key} must be a non-negative number` }, { status: 400 })
      }
      updates.push({ field: gasField, value: n })
      continue
    }
    const text = String(raw).trim()
    if (!text && key !== 'notes') {
      return NextResponse.json({ error: `${key} cannot be empty` }, { status: 400 })
    }
    updates.push({ field: gasField, value: text })
  }

  if (!updates.length) {
    return NextResponse.json({ error: 'No valid editable fields provided' }, { status: 400 })
  }

  const results: Array<{ field: string; ok: boolean; error?: string }> = []
  for (const patch of updates) {
    try {
      const payload = await mergeActorPayload(req, { id: orderId, field: patch.field, value: patch.value })
      const result = await dispatchUpdateOrderField(payload)
      if (result && typeof result === 'object' && 'error' in result && (result as { error?: string }).error) {
        results.push({ field: patch.field, ok: false, error: String((result as { error?: string }).error) })
      } else {
        results.push({ field: patch.field, ok: true })
      }
    } catch (e) {
      results.push({ field: patch.field, ok: false, error: (e as Error).message })
    }
  }

  const failed = results.filter(r => !r.ok)
  if (failed.length === results.length) {
    return NextResponse.json({ error: failed[0]?.error || 'All field updates failed', results }, { status: 502 })
  }

  return NextResponse.json({
    ok: true,
    orderId,
    updated: results.filter(r => r.ok).map(r => r.field),
    failed: failed.length ? failed : undefined,
  })
}
