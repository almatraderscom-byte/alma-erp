/**
 * Register a device's call-push token so the server can ring it for an office
 * call while the app is backgrounded / killed.
 *   POST /api/assistant/internal/call-push/register
 *     { platform: 'ios' | 'android', voipToken?: string, fcmToken?: string }
 *
 * Any authenticated user (owner OR staff) may register their own device — the
 * token is keyed to their ERP user id (token.sub). The native shells call this:
 * iOS with its PushKit VoIP token, Android with its FCM token.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { registerCallToken } from '@/agent/lib/call-push'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: { platform?: string; voipToken?: string; fcmToken?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const platform = body.platform === 'ios' || body.platform === 'android' ? body.platform : null
  if (!platform) return Response.json({ error: 'platform_required' }, { status: 400 })

  const voipToken = body.voipToken?.trim()
  const fcmToken = body.fcmToken?.trim()
  if (!voipToken && !fcmToken) return Response.json({ error: 'token_required' }, { status: 400 })

  try {
    if (voipToken) await registerCallToken({ userId: token.sub, platform, kind: 'voip', token: voipToken })
    if (fcmToken) await registerCallToken({ userId: token.sub, platform, kind: 'fcm', token: fcmToken })
  } catch (err) {
    console.error('[call-push/register] failed:', (err as Error)?.message)
    return Response.json({ error: 'register_failed' }, { status: 500 })
  }

  return Response.json({ ok: true })
}
