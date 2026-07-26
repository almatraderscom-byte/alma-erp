/**
 * Server-side client for the VPS live-browser service.
 *
 * One place that knows the base URL and the bearer token, so the API relay and
 * the agent tools cannot drift apart on either. Plain HTTP is fine here — this
 * only ever runs on the server, never in the owner's browser.
 */

export interface LiveCallResult<T = unknown> {
  ok: boolean
  status: number
  data?: T
  error?: string
}

export function liveBase(): string | null {
  const base = (process.env.BROWSER_LIVE_BASE ?? '').trim().replace(/\/$/, '')
  return base || null
}

export const LIVE_NOT_CONFIGURED =
  'লাইভ ব্রাউজার সেবার ঠিকানা সেট করা নেই, Boss — Vercel-এ BROWSER_LIVE_BASE বসাতে হবে (যেমন http://31.97.237.40:8781)।'

export async function callLiveService<T = unknown>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {},
): Promise<LiveCallResult<T>> {
  const base = liveBase()
  if (!base) return { ok: false, status: 503, error: LIVE_NOT_CONFIGURED }

  try {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${process.env.AGENT_INTERNAL_TOKEN ?? ''}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
      cache: 'no-store',
    })
    const data = (await res.json().catch(() => null)) as T | null
    if (!res.ok) {
      const message =
        (data as { message?: string; error?: string } | null)?.message ??
        (data as { error?: string } | null)?.error ??
        `live service returned ${res.status}`
      return { ok: false, status: res.status, error: message, data: data ?? undefined }
    }
    return { ok: true, status: res.status, data: data ?? undefined }
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Human-sized bytes for owner-facing lines. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}
