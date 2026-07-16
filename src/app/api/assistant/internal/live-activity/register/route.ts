/**
 * Register a device's ActivityKit push token so the server can update the
 * "Business Pulse" Dynamic Panel while the app is backgrounded / closed.
 *   POST /api/assistant/internal/live-activity/register
 *     { platform: 'ios', activityToken: string }
 *
 * The native shell posts this itself (LiveActivityBridge.observePushToken →
 * AlmaAPI, which copies the web session cookies into URLSession), exactly like
 * CallKitVoIP registers its PushKit token. The token is keyed to the caller's
 * own ERP user id — a caller can only ever register itself.
 *
 * Raw tokens are never logged (spec §15).
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { registerLiveActivityToken } from '@/agent/lib/live-activity-push'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: { platform?: string; activityToken?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const activityToken = body.activityToken?.trim()
  if (!activityToken) return Response.json({ error: 'token_required' }, { status: 400 })

  try {
    await registerLiveActivityToken({
      userId: token.sub,
      token: activityToken,
      platform: body.platform === 'android' ? 'android' : 'ios',
    })
  } catch (err) {
    console.error('[live-activity/register] failed:', (err as Error)?.message)
    return Response.json({ error: 'register_failed' }, { status: 500 })
  }

  return Response.json({ ok: true })
}
