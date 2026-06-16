import { NextRequest, NextResponse } from 'next/server'
import { buildSalahCallSayTwiml, buildSalahCallTwiml } from '@/lib/twilio/twiml'
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

  if (say && !audio) {
    return twiml(buildSalahCallSayTwiml(say))
  }
  if (audio) {
    return twiml(buildSalahCallTwiml(audio, say ?? undefined))
  }
  return twiml('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
}
