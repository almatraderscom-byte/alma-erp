import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { isGscConnected } from '@/agent/lib/gsc'
import { resolveGa4PropertyId, runGa4Report } from '@/agent/lib/ga4'
import { resolveGbpLocation } from '@/agent/lib/gbp'
import { getIndexNowKey, STOREFRONT_ORIGIN } from '@/agent/lib/growth/indexnow'
import { smsProviderConfigured } from '@/lib/sms/provider'

export const runtime = 'nodejs'

/**
 * One aggregated status snapshot for the Growth page board — the owner sees
 * every growth integration's real state (Features 1-8) at a glance, in plain
 * Bangla, with the exact next action when something is pending. Each probe is
 * independent and best-effort: one slow/broken integration never blanks the
 * whole board.
 */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const gscConnected = await isGscConnected().catch(() => false)

  const [ga4, gbp, indexnow] = await Promise.all([
    // GA4 — property id + a tiny real read (7d sessions) proves the whole chain.
    (async () => {
      const propertyId = resolveGa4PropertyId()
      if (!propertyId) return { state: 'needs_env' as const, propertyId: null, sessions7d: null }
      if (!gscConnected) return { state: 'needs_connect' as const, propertyId, sessions7d: null }
      const r = await runGa4Report({ startDate: '7daysAgo', endDate: 'yesterday', dimensions: [], metrics: ['sessions'] })
      if (!r.ok) return { state: r.kind === 'scope_missing' ? ('needs_reconnect' as const) : ('error' as const), propertyId, sessions7d: null, error: r.error }
      return { state: 'ok' as const, propertyId, sessions7d: r.rows[0]?.metrics[0] ?? 0 }
    })().catch((e) => ({ state: 'error' as const, propertyId: null, sessions7d: null, error: String(e) })),

    // GBP — resolve account/location; tagged kinds map straight to board states.
    (async () => {
      if (!gscConnected) return { state: 'needs_connect' as const }
      const r = await resolveGbpLocation()
      if (r.ok) return { state: 'ok' as const, location: r.data.title }
      if (r.kind === 'api_disabled') return { state: 'pending_google' as const, error: r.error }
      if (r.kind === 'scope_missing') return { state: 'needs_reconnect' as const, error: r.error }
      if (r.kind === 'no_location') return { state: 'no_location' as const, error: r.error }
      return { state: 'error' as const, error: r.error }
    })().catch((e) => ({ state: 'error' as const, error: String(e) })),

    // IndexNow — env key must match the file hosted on the storefront root.
    (async () => {
      const key = getIndexNowKey()
      if (!key) return { state: 'needs_env' as const, keyFileLive: false }
      try {
        const res = await fetch(`${STOREFRONT_ORIGIN}/${key}.txt`, { signal: AbortSignal.timeout(6000), cache: 'no-store' })
        const live = res.ok && (await res.text()).trim() === key
        return { state: live ? ('ok' as const) : ('key_file_missing' as const), keyFileLive: live }
      } catch {
        return { state: 'key_file_missing' as const, keyFileLive: false }
      }
    })(),
  ])

  return Response.json({
    gscConnected,
    ga4,
    gbp,
    indexnow,
    campaigns: {
      sms: smsProviderConfigured(),
      email: Boolean(process.env.RESEND_API_KEY),
      // Resend stays sandboxed (own-address only) until a domain is verified —
      // we can't probe that cheaply, so surface it as a standing note.
      emailNote: 'Resend-এ almatraders.com domain verify না করা পর্যন্ত email শুধু নিজের ঠিকানায় যায় (SMS-এ কোনো সীমা নেই)।',
    },
    // Feature 8 server layer ships with the app — if this route runs, it's on.
    finalSubmitBan: { serverLayer: true },
  })
}
