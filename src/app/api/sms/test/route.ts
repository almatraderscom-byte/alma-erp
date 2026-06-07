import { NextRequest, NextResponse } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { resolveBusinessId } from '@/lib/businesses'
import { flushQueuedSms } from '@/lib/sms/queue'

export async function POST(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN'])
  if (denied) return denied

  const body = await req.json().catch(() => ({})) as {
    business_id?: string
    phone?: string
    message?: string
  }
  const businessId = resolveBusinessId(body.business_id)
  const phone = String(body.phone || '').trim()
  if (!phone) {
    return NextResponse.json({ error: 'Phone is required' }, { status: 400 })
  }

  const result = await flushQueuedSms({
    businessId,
    phone,
    type: 'TEST',
    message: body.message?.trim() || 'ALMA ERP test SMS — settings are working.',
    metadata: { source: 'sms_test' },
    cooldownMinutes: 5,
  })

  return NextResponse.json({ ok: true, result })
}
