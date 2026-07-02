import { NextRequest, NextResponse } from 'next/server'
import { buildMessageCallTwiml, buildSalahCallSayTwiml, buildSalahCallTwiml } from '@/lib/twilio/twiml'
import { verifyTwilioRequest } from '@/lib/twilio/verify-signature'

export const runtime = 'nodejs'

function twiml(xml: string) {
  return new NextResponse(xml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  })
}

/** Twilio fetches this URL when the outbound call connects. */
export async function GET(req: NextRequest) {
  if (!verifyTwilioRequest(req, {})) {
    return new NextResponse('Forbidden', { status: 403 })
  }
  const audio = req.nextUrl.searchParams.get('audio')?.trim()
  const say = req.nextUrl.searchParams.get('say')?.trim()
  const once = req.nextUrl.searchParams.get('once') === '1'

  // Message-delivery call: play/say exactly once, then hang up (no repetition).
  if (once && (audio || say)) {
    return twiml(buildMessageCallTwiml(audio || undefined, say))
  }
  if (say && !audio) {
    return twiml(buildSalahCallSayTwiml(say))
  }
  if (audio) {
    return twiml(buildSalahCallTwiml(audio, say ?? undefined))
  }
  return twiml('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
}
