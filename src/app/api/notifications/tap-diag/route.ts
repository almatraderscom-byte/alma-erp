import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { logEvent } from '@/lib/logger'

export const revalidate = 0

/**
 * TEMPORARY diagnostic — notification-tap chain (owner bug, 2026-07-16).
 *
 * The owner reports that tapping ANY notification on the native iOS app lands on
 * the Dashboard instead of the notification's page, and turning the native-screens
 * toggle off changed nothing — which points at the OneSignal JS click listener
 * never firing, i.e. every fix downstream of it (AlmaNavBridge deep-link) is dead
 * code. Native diagnostics proved the bridge IS present in the webview
 * (window.Capacitor.Plugins.AlmaNavBridge === true, origin + platform correct), so
 * the break is upstream, inside the click event itself.
 *
 * This endpoint just records what the CLIENT saw, so one real tap on the owner's
 * phone tells us which link is broken — no new TestFlight build needed, since the
 * caller (src/lib/native-push.ts) ships via Vercel.
 *
 * REMOVE once the root cause is fixed. Logs only; stores nothing.
 */
export async function POST(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    stage?: string
    detail?: Record<string, unknown> | null
    at?: string
  }

  logEvent('warn', 'notif_tap_diag', {
    stage: String(body.stage || 'unknown'),
    userId: token.sub,
    at: body.at || null,
    // Truncated client-side already; clamp again so a huge payload can't bloat logs.
    detail: body.detail ? JSON.stringify(body.detail).slice(0, 2000) : null,
  })

  return NextResponse.json({ ok: true })
}
