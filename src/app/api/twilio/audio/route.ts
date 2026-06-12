import { NextRequest, NextResponse } from 'next/server'
import { verifyAudioToken } from '@/lib/twilio/audio-token'

export const runtime = 'nodejs'

/** Twilio <Play> fetches telephony WAV via this proxy (correct Content-Type). */
export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get('path')?.trim()
  const exp = Number(req.nextUrl.searchParams.get('exp'))
  const token = req.nextUrl.searchParams.get('t')?.trim() ?? ''

  if (!path || !path.startsWith('calls/') || path.includes('..')) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 })
  }
  if (!verifyAudioToken(path, exp, token)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '')
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: 'storage not configured' }, { status: 500 })
  }

  const objectUrl = `${supabaseUrl}/storage/v1/object/agent-files/${path}`
  const res = await fetch(objectUrl, {
    headers: { Authorization: `Bearer ${serviceKey}` },
  })
  if (!res.ok) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const buf = Buffer.from(await res.arrayBuffer())
  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
      'Content-Length': String(buf.length),
    },
  })
}
