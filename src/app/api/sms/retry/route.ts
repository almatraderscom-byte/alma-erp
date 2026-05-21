import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { retrySmsLog } from '@/lib/sms/queue'

export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied
  const body = await req.json().catch(() => ({})) as { id?: string }
  const id = String(body.id || '').trim()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const result = await retrySmsLog(id)
  return NextResponse.json(result, { status: result.ok ? 200 : 404 })
}
