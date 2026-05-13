/**
 * server-api.ts
 *
 * Server-side only — runs inside Next.js Route Handlers (src/app/api/*).
 * Has access to API_SECRET (no NEXT_PUBLIC_ prefix = not in browser bundle).
 * Adds the secret + route before forwarding to Google Apps Script.
 */

const BASE    = process.env.NEXT_PUBLIC_API_URL ?? ''
const SECRET  = process.env.API_SECRET ?? 'alma-dev-secret'
const TIMEOUT = 20_000    // GAS can be slow on cold starts

// ── GET ──────────────────────────────────────────────────────────────────────
export async function serverGet<T>(
  route: string,
  params: Record<string, string> = {},
  revalidate = 30,
): Promise<T> {
  assertConfigured_()
  const url = new URL(BASE)
  url.searchParams.set('route', route)
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') url.searchParams.set(k, v) })

  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)

  try {
    const res  = await fetch(url.toString(), {
      next:     { revalidate },
      redirect: 'follow',
      signal:   ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`GAS GET ${route} → HTTP ${res.status}`)
    const data = await safeJson_<{ error?: string } & T>(res, route)
    if (data.error) throw new Error(data.error)
    return data as T
  } catch (err) {
    clearTimeout(timer)
    throw normalise_(err, `GET ${route}`)
  }
}

// ── POST ─────────────────────────────────────────────────────────────────────
export async function serverPost<T>(
  route: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  assertConfigured_()
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)

  try {
    const res = await fetch(BASE, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     JSON.stringify({ route, secret: SECRET, ...payload }),
      redirect: 'follow',
      cache:    'no-store',
      signal:   ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`GAS POST ${route} → HTTP ${res.status}`)
    const data = await safeJson_<{ error?: string } & T>(res, route)
    if (data.error) throw new Error(data.error)
    return data as T
  } catch (err) {
    clearTimeout(timer)
    throw normalise_(err, `POST ${route}`)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function assertConfigured_() {
  if (!BASE || BASE.includes('YOUR_GOOGLE_SHEET_ID')) {
    throw new Error('NEXT_PUBLIC_API_URL is not configured — check .env.local')
  }
}

async function safeJson_<T>(res: Response, route: string): Promise<T> {
  const text = await res.text()
  if (!text.trim()) throw new Error(`${route} returned empty response`)
  try { return JSON.parse(text) as T }
  catch { throw new Error(`${route} returned non-JSON: ${text.slice(0, 120)}`) }
}

function normalise_(err: unknown, context: string): Error {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return new Error(`${context} timed out after ${TIMEOUT}ms`)
    return err
  }
  return new Error(String(err))
}

// Named export for backward compatibility with existing route handlers
export const serverApi = { get: serverGet, post: serverPost }
