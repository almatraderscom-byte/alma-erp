import { NextRequest, NextResponse } from 'next/server'
import { handleOutboundCallMissed, handleOutboundCallAnswered } from '@/agent/lib/outbound-call-missed'
import { verifyTwilioRequest, formDataToParams } from '@/lib/twilio/verify-signature'
import { extractBearerToken, verifyAgentInternalToken } from '@/lib/agent-internal-auth'

export const runtime = 'nodejs'

/**
 * Twilio StatusCallback — logs delivery quality; offers owner retry when outbound call missed.
 *
 * Accepts EITHER:
 *  - Valid Twilio x-twilio-signature (real Twilio webhook)
 *  - Authorization: Bearer ${AGENT_INTERNAL_TOKEN} (worker poll fallback)
 */
export async function POST(req: NextRequest) {
  const body = await req.formData().catch(() => null)
  if (!body) return new NextResponse('', { status: 400 })

  const bearer = extractBearerToken(req.headers.get('authorization'))
  const internalOk = bearer && verifyAgentInternalToken(bearer)
  const twilioOk = verifyTwilioRequest(req, formDataToParams(body))
  if (!internalOk && !twilioOk) {
    return new NextResponse('Forbidden', { status: 403 })
  }

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
    try {
      const missed = await handleOutboundCallMissed({
        callSid: sid,
        callStatus: status,
        durationSec: duration,
        toNumber: to,
      })
      if (missed.handled) {
        console.log('[twilio:call-status] outbound retry offered:', missed.retryActionId)
      }
    } catch (err) {
      console.error('[twilio:call-status] outbound missed handler error:', err)
    }
  } else {
    console.log('[twilio:call-status]', { sid, status, duration })
    if (status === 'completed' && duration >= 12) {
      try {
        const answered = await handleOutboundCallAnswered({
          callSid: sid,
          callStatus: status,
          durationSec: duration,
          toNumber: to,
        })
        if (answered.handled) {
          console.log('[twilio:call-status] outbound answered notified')
        }
      } catch (err) {
        console.error('[twilio:call-status] outbound answered handler error:', err)
      }
    }
  }

  return new NextResponse('', { status: 200 })
}
