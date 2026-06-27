import { NextRequest, NextResponse } from 'next/server'
import { getLifestyleStock } from '@/lib/lifestyle/read'
import { dispatchInventoryAction } from '@/lib/lifestyle/write-dispatch'
import { prisma } from '@/lib/prisma'
import { notifyRole } from '@/lib/notifications'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { enqueueLowStockAlertSms } from '@/services/sms/events'
import { logEvent } from '@/lib/logger'
import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { redactStockCost } from '@/lib/lifestyle/redact-cost'
import { apiFailure } from '@/lib/safe-api-response'

export async function GET(req: NextRequest) {
  try {
    const token = await getJwt(req)
    const role = normalizeAlmaRole(token?.role as string)
    const data = await getLifestyleStock()
    const low = Number(data.summary?.low_stock || 0)
    const out = Number(data.summary?.out_of_stock || 0)
    if (low || out) {
      const since = new Date(Date.now() - 12 * 60 * 60 * 1000)
      const existing = await prisma.notification.count({
        where: { type: 'LOW_STOCK', businessId: 'ALMA_LIFESTYLE', createdAt: { gte: since } },
      })
      if (!existing) {
        void Promise.all([
          enqueueLowStockAlertSms({ businessId: 'ALMA_LIFESTYLE', product: out ? 'out-of-stock inventory' : 'low-stock inventory' }),
          notifyRole({
            role: 'ADMIN',
            businessId: 'ALMA_LIFESTYLE',
            type: 'LOW_STOCK',
            priority: out ? 'HIGH' : 'NORMAL',
            title: out ? 'Out-of-stock items detected' : 'Low stock alert',
            message: `${low} SKU(s) are low stock and ${out} SKU(s) are out of stock.`,
            actionUrl: '/inventory',
          }),
        ]).catch(error => logEvent('warn', 'stock.low_stock_dispatch_failed', { error: (error as Error).message }))
      }
    }
    return NextResponse.json(redactStockCost(data, role), {
      headers: { 'Cache-Control': 'private, max-age=30, stale-while-revalidate=60' },
    })
  } catch (e) {
    logEvent('error', 'stock.read_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not load inventory.', { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>
    const action = String(body.action || '')
    if (!action) return NextResponse.json({ error: 'Invalid inventory action' }, { status: 400 })
    const result = await dispatchInventoryAction(await mergeActorPayload(req, body))
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
