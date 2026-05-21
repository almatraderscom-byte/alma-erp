import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { resolveBusinessId } from '@/lib/businesses'
import { queueSms, processSmsQueue } from '@/lib/sms/queue'

export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN'])
  if (denied) return denied
  const body = await req.json().catch(() => ({})) as { phone?: string; message?: string; business_id?: string }
  const queued = await queueSms({
    businessId: resolveBusinessId(body.business_id),
    phone: String(body.phone || ''),
    type: 'TEST',
    message: String(body.message || 'ALMA SMS test').slice(0, 300),
    cooldownMinutes: 1,
  })
  if (!queued.ok) return NextResponse.json(queued, { status: 400 })
  const processed = await processSmsQueue({ limit: 1 })
  return NextResponse.json({ ok: true, queued, processed })
}
