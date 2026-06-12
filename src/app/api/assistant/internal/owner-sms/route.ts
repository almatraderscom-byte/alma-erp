/**
 * POST /api/assistant/internal/owner-sms
 * Worker-only: SMS to owner (salah escalation).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { processSmsQueue, queueSms } from '@/lib/sms/queue'
import { resolveBusinessId } from '@/lib/businesses'

export const runtime = 'nodejs'

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { message?: string; phone?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const message = String(body.message ?? '').trim()
  const phone = String(body.phone ?? process.env.OWNER_SMS_PHONE ?? '').trim()
  if (!message) return NextResponse.json({ error: 'message required' }, { status: 400 })
  if (!phone) return NextResponse.json({ error: 'OWNER_SMS_PHONE not configured' }, { status: 400 })

  const queued = await queueSms({
    businessId: resolveBusinessId(undefined),
    phone,
    type: 'TEST',
    message: message.slice(0, 918),
    cooldownMinutes: 5,
  })
  if (!queued.ok) return NextResponse.json(queued, { status: 400 })

  const processed = await processSmsQueue({ limit: 1 })
  return NextResponse.json({ ok: true, queued, processed })
}
