import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

/**
 * Twilio StatusCallback — logs delivery quality for ops.
 * Short completed calls (<12s) often mean the handset never rang (carrier ghost-connect).
 */
export async function POST(req: NextRequest) {
  const body = await req.formData().catch(() => null)
  if (!body) return new NextResponse('', { status: 400 })

  const status = String(body.get('CallStatus') ?? '')
  const duration = Number(body.get('CallDuration') ?? 0)
  const sid = String(body.get('CallSid') ?? '')
  const to = String(body.get('To') ?? '')

  const suspicious =
    status === 'no-answer'
    || status === 'busy'
    || status === 'failed'
    || (status === 'completed' && duration > 0 && duration < 12)

  if (suspicious) {
    console.warn('[twilio:call-status]', { sid, status, duration, toLast4: to.slice(-4) })
  } else {
    console.log('[twilio:call-status]', { sid, status, duration })
  }

  return new NextResponse('', { status: 200 })
}
