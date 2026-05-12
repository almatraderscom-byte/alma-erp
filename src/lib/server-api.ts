/**
 * Server-side API functions
 * Used by Next.js API route handlers.
 * Keeps API secrets hidden from the browser.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? ''
const SECRET = process.env.API_SECRET ?? 'alma-dev-secret'
const TIMEOUT = 18_000

async function serverGet<T>(route: string, params: Record<string, string> = {}, revalidate = 30): Promise<T> {
  if (!BASE || BASE.includes('YOUR_DEPLOYMENT')) throw new Error('API not configured')
  const url = new URL(BASE)
  url.searchParams.set('route', route)
  Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v) })
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), TIMEOUT)
  const res = await fetch(url.toString(), { next: { revalidate }, redirect: 'follow', signal: ctrl.signal })
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data as T
}

async function serverPost<T>(route: string, payload: Record<string, unknown>): Promise<T> {
  if (!BASE || BASE.includes('YOUR_DEPLOYMENT')) throw new Error('API not configured')
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), TIMEOUT)
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ route, secret: SECRET, ...payload }),
    redirect: 'follow', cache: 'no-store', signal: ctrl.signal,
  })
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data as T
}

export const serverApi = { get: serverGet, post: serverPost }
