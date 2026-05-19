import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { retryTelegramNotification } from '@/lib/telegram-notification/queue'

export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied

  const body = (await req.json().catch(() => ({}))) as { id?: string }
  if (!body.id) return NextResponse.json({ error: 'Queue id required' }, { status: 400 })

  const result = await retryTelegramNotification(body.id)
  return NextResponse.json({ ok: true, result })
}
