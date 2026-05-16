import { NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'
import { prisma } from '@/lib/prisma'
import { notifyRole } from '@/lib/notifications'

export async function GET() {
  try {
    const data = await serverGet<{ summary?: { low_stock?: number; out_of_stock?: number } }>('stock', {}, 0)
    const low = Number(data.summary?.low_stock || 0)
    const out = Number(data.summary?.out_of_stock || 0)
    if (low || out) {
      const since = new Date(Date.now() - 12 * 60 * 60 * 1000)
      const existing = await prisma.notification.count({
        where: { type: 'LOW_STOCK', businessId: 'ALMA_LIFESTYLE', createdAt: { gte: since } },
      })
      if (!existing) {
        await notifyRole({
          role: 'ADMIN',
          businessId: 'ALMA_LIFESTYLE',
          type: 'LOW_STOCK',
          priority: out ? 'HIGH' : 'NORMAL',
          title: out ? 'Out-of-stock items detected' : 'Low stock alert',
          message: `${low} SKU(s) are low stock and ${out} SKU(s) are out of stock.`,
          actionUrl: '/inventory',
        })
      }
    }
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'private, no-store, must-revalidate' },
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
