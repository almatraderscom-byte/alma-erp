/**
 * server-api.ts
 *
 * Server-side only — runs inside Next.js Route Handlers (src/app/api/*).
 * Has access to API_SECRET (no NEXT_PUBLIC_ prefix = not in browser bundle).
 * Adds the secret + route before forwarding to Google Apps Script.
 */

const BASE    = process.env.NEXT_PUBLIC_API_URL ?? ''
const SECRET  = process.env.API_SECRET ?? 'alma-dev-secret'
/** Default for most GAS routes (cold start + small payload). */
const DEFAULT_TIMEOUT_MS = 25_000
/** Invoice: PDF + Drive can take 20–40s+; keep headroom above Vercel/server limits. */
export const INVOICE_SERVER_TIMEOUT_MS = 90_000

export type ServerFetchOptions = { timeoutMs?: number }

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

  const timeoutMs = DEFAULT_TIMEOUT_MS
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

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
    throw normalise_(err, `GET ${route}`, timeoutMs)
  }
}

// ── POST ─────────────────────────────────────────────────────────────────────
export async function serverPost<T>(
  route: string,
  payload: Record<string, unknown> = {},
  options?: ServerFetchOptions,
): Promise<T> {
  assertConfigured_()
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const body  = JSON.stringify({ route, secret: SECRET, ...payload })

  console.log(`[serverPost →] route=${route} keys=${Object.keys({ route, ...payload }).join(',')}`)

  try {
    const res = await fetch(BASE, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body,
      redirect: 'follow',
      cache:    'no-store',
      signal:   ctrl.signal,
    })
    clearTimeout(timer)

    console.log(`[serverPost ←] route=${route} status=${res.status} url=${res.url.slice(0, 80)}`)

    const text = await res.text()
    console.log(`[serverPost body] route=${route} response=${text.slice(0, 400)}`)
    if (!text.trim()) throw new Error(`${route} returned empty response`)

    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const errBody = JSON.parse(text) as { error?: string }
        if (errBody.error) detail = errBody.error
        else detail = text.slice(0, 280)
      } catch {
        detail = text.slice(0, 280)
      }
      throw new Error(`GAS POST ${route} → ${detail}`)
    }

    let data: { error?: string; ok?: boolean } & T
    try { data = JSON.parse(text) as { error?: string; ok?: boolean } & T }
    catch { throw new Error(`${route} returned non-JSON: ${text.slice(0, 120)}`) }
    if (data.error) throw new Error(data.error)
    if (data && typeof data === 'object' && data.ok === false) {
      const d = data as { error?: string; message?: string }
      const msg = d.error || d.message || 'Request returned ok: false'
      throw new Error(msg)
    }
    return data as T
  } catch (err) {
    clearTimeout(timer)
    console.error(`[serverPost ✗] route=${route}`, (err as Error).message)
    throw normalise_(err, `POST ${route}`, timeoutMs)
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

function normalise_(err: unknown, context: string, timeoutMs: number): Error {
  if (err instanceof Error) {
    if (err.name === 'AbortError')
      return new Error(`${context} timed out after ${timeoutMs}ms — GAS may still be finishing; check Drive and AUTOMATION LOG before retrying.`)
    return err
  }
  return new Error(String(err))
}

// Named export for backward compatibility with existing route handlers
export const serverApi = { get: serverGet, post: serverPost }
