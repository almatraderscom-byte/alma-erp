import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { isGscConnected } from '@/agent/lib/gsc'
import { resolveGa4PropertyId, runGa4Report } from '@/agent/lib/ga4'
import { resolveGbpLocation } from '@/agent/lib/gbp'
import { getIndexNowKey, STOREFRONT_ORIGIN } from '@/agent/lib/growth/indexnow'
import { smsProviderConfigured, fetchSmsBalance } from '@/lib/sms/provider'

export const runtime = 'nodejs'

/**
 * One aggregated status snapshot for the Growth page board — the owner sees
 * every growth integration's real state (Features 1-8) at a glance, in plain
 * Bangla, with the exact next action when something is pending.
 *
 * Hardening rules (each probe follows all three):
 *  1. TRUTH over vibes — every green state is proven by a real read (GA4
 *     sessions, GBP location, storefront key file, SMS balance, Resend domain
 *     list), never by "env var is set".
 *  2. TIME-BOXED — every probe races an 8s deadline so one slow upstream can
 *     never hang the whole board into a Vercel timeout.
 *  3. ISOLATED — every probe catches everything; one broken integration shows
 *     its own error row, the rest of the board still renders.
 */

const PROBE_TIMEOUT_MS = 8_000

function withDeadline<T, F>(p: Promise<T>, fallback: F): Promise<T | F> {
  return Promise.race<T | F>([
    p,
    new Promise<F>((resolve) => setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS)),
  ]).catch(() => fallback)
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const gscConnected = await withDeadline(isGscConnected(), false)

  const [ga4, gbp, indexnow, sms, email] = await Promise.all([
    // GA4 — property id + a tiny real read (7d sessions) proves the whole chain.
    withDeadline(
      (async () => {
        const propertyId = resolveGa4PropertyId()
        if (!propertyId) return { state: 'needs_env' as const, propertyId: null, sessions7d: null as number | null }
        if (!gscConnected) return { state: 'needs_connect' as const, propertyId, sessions7d: null }
        const r = await runGa4Report({ startDate: '7daysAgo', endDate: 'yesterday', dimensions: [], metrics: ['sessions'] })
        if (!r.ok) {
          return {
            state: r.kind === 'scope_missing' ? ('needs_reconnect' as const) : ('error' as const),
            propertyId,
            sessions7d: null,
            error: r.error,
          }
        }
        return { state: 'ok' as const, propertyId, sessions7d: r.rows[0]?.metrics[0] ?? 0 }
      })(),
      { state: 'timeout' as const, propertyId: resolveGa4PropertyId(), sessions7d: null },
    ),

    // GBP — resolve account/location; tagged kinds map straight to board states.
    withDeadline(
      (async () => {
        if (!gscConnected) return { state: 'needs_connect' as const }
        const r = await resolveGbpLocation()
        if (r.ok) return { state: 'ok' as const, location: r.data.title }
        if (r.kind === 'api_disabled') return { state: 'pending_google' as const, error: r.error }
        if (r.kind === 'scope_missing') return { state: 'needs_reconnect' as const, error: r.error }
        if (r.kind === 'no_location') return { state: 'no_location' as const, error: r.error }
        return { state: 'error' as const, error: r.error }
      })(),
      { state: 'timeout' as const },
    ),

    // IndexNow — env key must match the file actually hosted on the storefront root.
    withDeadline(
      (async () => {
        const key = getIndexNowKey()
        if (!key) return { state: 'needs_env' as const, keyFileLive: false }
        const res = await fetch(`${STOREFRONT_ORIGIN}/${key}.txt`, {
          signal: AbortSignal.timeout(6000),
          cache: 'no-store',
        })
        const live = res.ok && (await res.text()).trim() === key
        return { state: live ? ('ok' as const) : ('key_file_missing' as const), keyFileLive: live }
      })(),
      { state: 'key_file_missing' as const, keyFileLive: false },
    ),

    // SMS — a real balance read proves the key is VALID, not merely present.
    withDeadline(
      (async () => {
        if (!smsProviderConfigured()) return { state: 'needs_env' as const, balance: null as string | null }
        const r = await fetchSmsBalance()
        if (!r.ok) return { state: 'bad_key' as const, balance: null, error: r.error }
        const bal = (r.data as { balance?: unknown } | undefined)?.balance
        return { state: 'ok' as const, balance: bal != null ? String(bal) : null }
      })(),
      { state: 'timeout' as const, balance: null },
    ),

    // Email — Resend domain list answers BOTH "key valid?" and "still sandbox?".
    withDeadline(
      (async () => {
        const key = (process.env.RESEND_API_KEY ?? '').trim()
        if (!key) return { state: 'needs_env' as const, domain: null as string | null }
        const res = await fetch('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(6000),
          cache: 'no-store',
        })
        if (res.status === 401 || res.status === 403) {
          // A send-only ("restricted") Resend key CAN send mail but CANNOT list
          // domains — that's a working key, not a broken one. Only a genuinely
          // invalid key gets bad_key.
          const body = await res.text().catch(() => '')
          return /restricted|only.*send/i.test(body)
            ? { state: 'send_only' as const, domain: null }
            : { state: 'bad_key' as const, domain: null }
        }
        if (!res.ok) return { state: 'error' as const, domain: null }
        const data = (await res.json().catch(() => ({}))) as { data?: Array<{ name?: string; status?: string }> }
        const verified = (data.data ?? []).find((d) => d.status === 'verified')
        return verified
          ? { state: 'ok' as const, domain: verified.name ?? null }
          : { state: 'sandbox' as const, domain: null }
      })(),
      { state: 'timeout' as const, domain: null },
    ),
  ])

  return Response.json({
    generatedAt: new Date().toISOString(),
    gscConnected,
    ga4,
    gbp,
    indexnow,
    campaigns: { sms, email },
    // Feature 8 server layer ships with the app — if this route runs, it's on.
    finalSubmitBan: { serverLayer: true },
  })
}
