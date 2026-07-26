/**
 * Owner-only relay to the VPS live-browser service.
 *
 * The live Chromium runs on the VPS and listens on plain HTTP. The owner's page
 * is served over HTTPS, and a browser will not open a plain-HTTP or ws:// stream
 * from an HTTPS page — so the frames come through here instead: the server fetches
 * them over the internal network and re-emits them to the owner. That also means
 * the live service never has to be exposed to the public internet, and its bearer
 * token never leaves the server.
 *
 * If a TLS endpoint is ever put in front of the VPS service, the browser can talk
 * to it directly and this relay simply stops being used — the two routes it proxies
 * (an SSE stream and a POST) are the same either way.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { isSystemOwner } from '@/lib/roles'

/** Server-side only — plain HTTP is fine here, this never reaches the browser. */
export function liveBase(): string | null {
  const base = (process.env.BROWSER_LIVE_BASE ?? '').trim().replace(/\/$/, '')
  return base || null
}

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Owner-or-internal gate. Returns a Response to send back when the caller is not
 * allowed, or null when it may proceed.
 *
 * Live browsing puts a real, interactive browser in the caller's hands, so this
 * is owner-only — never a general staff surface.
 */
export async function requireOwner(req: NextRequest): Promise<Response | null> {
  const authHeader = req.headers.get('authorization') ?? ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (verifyInternalToken(bearer)) return null

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

function internalHeaders(): HeadersInit {
  return { Authorization: `Bearer ${process.env.AGENT_INTERNAL_TOKEN ?? ''}` }
}

/** Proxy a JSON call to the live service. */
export async function callLive(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = { method: 'GET' },
): Promise<Response> {
  const base = liveBase()
  if (!base) {
    return Response.json(
      {
        error: 'browser_live_not_configured',
        message:
          'লাইভ ব্রাউজার সেবার ঠিকানা সেট করা নেই, Boss — Vercel-এ BROWSER_LIVE_BASE বসাতে হবে ' +
          '(যেমন http://31.97.237.40:8781)।',
      },
      { status: 503 },
    )
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method: init.method,
      headers: { ...internalHeaders(), ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
      cache: 'no-store',
    })
    const text = await res.text()
    return new Response(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    })
  } catch (err) {
    return Response.json(
      { error: 'browser_live_unreachable', message: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}
