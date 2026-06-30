/**
 * GET /api/assistant/wa-selftest — owner-only live WhatsApp self-test.
 *
 * Lets the logged-in owner fire a REAL WhatsApp text and/or a one-way voice call to
 * a number (their own) so we can prove the Twilio WhatsApp plumbing end-to-end —
 * something that can only run inside the Vercel runtime where the Twilio creds live.
 *
 * Owner-gated (NextAuth session, SUPER_ADMIN) so a stray hit can't make us message
 * anyone, and still double-gated by the existing kill switches (WHATSAPP_SEND_ENABLED
 * / WHATSAPP_CALL_ENABLED) inside the send/call helpers. Dormant without Twilio creds.
 *
 * Usage (while logged in as owner):
 *   /api/assistant/wa-selftest?to=+8801XXXXXXXXX            → text + call (default)
 *   /api/assistant/wa-selftest?to=+8801XXXXXXXXX&do=text    → text only
 *   /api/assistant/wa-selftest?to=+8801XXXXXXXXX&do=call    → call only
 *   &msg=...  → override the text/spoken message
 *
 * Returns the raw Twilio result (sid or error) for each, so the outcome — including
 * the exact error if WhatsApp Business Calling / call-permission isn't enabled yet —
 * is visible without guessing.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { sendTwilioWaText, placeTwilioWaCall, getTwilioCallStatus, twilioWaConfigured } from '@/agent/lib/wa/twilio-wa'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)

  // Diagnostic: ?status=<CallSid> → look up why a created call didn't ring.
  const statusSid = (searchParams.get('status') ?? '').trim()
  if (statusSid) {
    if (!twilioWaConfigured()) {
      return Response.json({ error: 'not_configured' }, { status: 503 })
    }
    const callStatus = await getTwilioCallStatus(statusSid)
    console.log('[wa-selftest:status]', JSON.stringify({ sid: statusSid, callStatus }))
    return Response.json({ ok: true, sid: statusSid, callStatus })
  }

  const to = (searchParams.get('to') ?? '').trim()
  const doParam = (searchParams.get('do') ?? 'both').trim().toLowerCase()
  const msg = (searchParams.get('msg') ?? '').trim()

  if (!to || !/^\+?\d[\d\s\-()]{6,}$/.test(to)) {
    return Response.json(
      { error: 'bad_to', message: 'Pass ?to=+8801XXXXXXXXX (your WhatsApp number in international format).' },
      { status: 400 },
    )
  }
  if (!twilioWaConfigured()) {
    return Response.json(
      { error: 'not_configured', message: 'Twilio WhatsApp creds not set on this deployment (TWILIO_WHATSAPP_FROM).' },
      { status: 503 },
    )
  }

  const wantText = doParam === 'both' || doParam === 'text'
  const wantCall = doParam === 'both' || doParam === 'call'

  const textMsg = msg || 'ALMA এজেন্ট থেকে টেস্ট মেসেজ ✅ — WhatsApp ঠিকভাবে কাজ করছে।'
  const callMsg = msg || 'আসসালামু আলাইকুম। এটি ALMA এজেন্টের একটি টেস্ট কল। ধন্যবাদ।'

  const result: Record<string, unknown> = { to, ran: { text: wantText, call: wantCall } }

  if (wantText) {
    result.text = await sendTwilioWaText({ to, body: textMsg })
  }
  if (wantCall) {
    result.call = await placeTwilioWaCall({ to, message: callMsg })
  }

  // Log the outcome so the result (esp. any Twilio call error) is visible in runtime
  // logs without depending on the caller screenshotting the JSON.
  console.log('[wa-selftest]', JSON.stringify({ to, text: result.text ?? null, call: result.call ?? null }))

  return Response.json({ ok: true, ...result })
}
