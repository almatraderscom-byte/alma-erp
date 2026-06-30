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
import { sendTwilioWaText, placeTwilioWaCall, getTwilioCallStatus, getTwilioCallError, getTwilioRecentInbound, twilioWaConfigured } from '@/agent/lib/wa/twilio-wa'
import { mirrorOwnerNotifyToWhatsApp } from '@/agent/lib/telegram-owner-notify'
import { testWaApproval } from '@/agent/lib/wa/wa-approval'
import { sendOwnerWaVoice } from '@/agent/lib/wa/wa-voice'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { searchParams } = new URL(req.url)

  // Test the owner-notification channel end to end: fires sendOwnerText, which now
  // also mirrors to the owner's WhatsApp (OWNER_WHATSAPP_NUMBER). Proves the agent can
  // push notifications/reminders to the owner on WhatsApp.
  const notify = (searchParams.get('notify') ?? '').trim()
  if (notify) {
    const text = notify === '1' ? '🔔 ALMA এজেন্ট টেস্ট নোটিফিকেশন — WhatsApp চ্যানেল চালু আছে।' : notify
    // Test the WhatsApp owner-notify mirror directly (returns sent/skip + reason so the
    // exact blocker is visible). Not via sendOwnerText — that would mirror a 2nd time.
    const whatsapp = await mirrorOwnerNotifyToWhatsApp(text)
    console.log('[wa-selftest:notify]', JSON.stringify({ whatsapp }))
    return Response.json({
      ok: true,
      ownerWhatsAppConfigured: Boolean(process.env.OWNER_WHATSAPP_NUMBER),
      whatsapp,
    })
  }

  // Test the WhatsApp voice note: speaks `voice` text (default a Bangla greeting).
  const voice = (searchParams.get('voice') ?? '').trim()
  if (voice) {
    const text = voice === '1' ? 'আসসালামু আলাইকুম বস। এটি ALMA এজেন্টের একটি ভয়েস টেস্ট। WhatsApp-এ ভয়েস ঠিকভাবে আসছে।' : voice
    const result = await sendOwnerWaVoice(text, Date.now(), '🎙️ ভয়েস টেস্ট')
    console.log('[wa-selftest:voice]', JSON.stringify(result))
    return Response.json({ ok: true, ...result })
  }

  // Diagnostic: ?approval=1 → create the quick-reply template + send the owner a test
  // approval with tap-buttons (✅/❌). Tapping a button is a safe no-op (TEST-NO-OP).
  const approval = (searchParams.get('approval') ?? '').trim()
  if (approval) {
    const result = await testWaApproval(approval === 'multi' ? 'multi' : 'single')
    console.log('[wa-selftest:approval]', JSON.stringify(result))
    return Response.json({ ok: true, kind: approval === 'multi' ? 'multi' : 'single', ...result })
  }

  // Diagnostic: ?inbound=1 → did Twilio itself receive any inbound WhatsApp? Tells a
  // webhook problem (Twilio has them, didn't forward) from Coexistence (Twilio never got them).
  if ((searchParams.get('inbound') ?? '') === '1') {
    const recent = await getTwilioRecentInbound()
    console.log('[wa-selftest:inbound]', JSON.stringify(recent))
    return Response.json({ ok: true, ...recent })
  }

  // Diagnostic: ?status=<CallSid> → look up why a created call didn't ring.
  const statusSid = (searchParams.get('status') ?? '').trim()
  if (statusSid) {
    if (!twilioWaConfigured()) {
      return Response.json({ error: 'not_configured' }, { status: 503 })
    }
    const [callStatus, callError] = await Promise.all([
      getTwilioCallStatus(statusSid),
      getTwilioCallError(statusSid),
    ])
    console.log('[wa-selftest:status]', JSON.stringify({ sid: statusSid, callStatus, callError }))
    return Response.json({ ok: true, sid: statusSid, callStatus, callError })
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
