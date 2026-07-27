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

/**
 * KV kill-switch, default OFF like every other new capability in this project.
 *
 * A live session is a Chromium held open for minutes on the same two-core box
 * that carries the phone calls, so it is opt-in: the owner turns it on when he
 * wants it and can turn it off from settings without a deploy if it ever gets in
 * the way of a call.
 */
export const LIVE_VIEW_ENABLED_KEY = 'browser_live_view_enabled'

export async function isLiveViewEnabled(): Promise<boolean> {
  try {
    const { prisma } = await import('@/lib/prisma')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({
      where: { key: LIVE_VIEW_ENABLED_KEY },
      select: { value: true },
    })
    return row?.value === 'true'
  } catch {
    return false // unreadable setting ⇒ stay off, never open a browser on a guess
  }
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
