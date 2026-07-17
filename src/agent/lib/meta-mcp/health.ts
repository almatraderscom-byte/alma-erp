/**
 * Meta Ads MCP — observability (Phase MA4).
 *
 * Aggregates the telemetry every bridged tool already writes (AgentToolEvent,
 * toolName `meta_ads_*` for reads and `meta_ads:*` for approved writes) into a
 * health snapshot — call counts, success rate, error breakdown, last success —
 * surfaced on the status route + growth card. Plus a THROTTLED owner ntfy when
 * the connection needs re-auth, so a silently-expired token doesn't just fail
 * quietly (plan §7 "ntfy alert on auth expiry").
 *
 * Read-only + fail-open: telemetry problems never throw into a turn or a route.
 */
import { prisma } from '@/lib/prisma'
import { notifyOwner } from '@/agent/lib/notify-owner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const KV_LAST_AUTH_ALERT = 'meta_mcp_last_auth_alert'
const AUTH_ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000

export interface MetaMcpHealthWindow {
  calls: number
  ok: number
  failed: number
  successRate: number | null
  /** errorCode → count (e.g. { auth: 3, rate_limited: 1 }). */
  errors: Record<string, number>
}

export interface MetaMcpHealth {
  last24h: MetaMcpHealthWindow
  last7d: MetaMcpHealthWindow
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: { code: string | null; toolName: string } | null
}

/** Is this telemetry row a Meta MCP tool call (read `meta_ads_*` or write `meta_ads:*`)? */
function isMetaTool(name: string): boolean {
  return name.startsWith('meta_ads_') || name.startsWith('meta_ads:')
}

function windowFrom(rows: Array<{ success: boolean; errorCode: string | null }>): MetaMcpHealthWindow {
  const ok = rows.filter((r) => r.success).length
  const failed = rows.length - ok
  const errors: Record<string, number> = {}
  for (const r of rows) {
    if (!r.success) {
      const code = r.errorCode ?? 'unknown'
      errors[code] = (errors[code] ?? 0) + 1
    }
  }
  return {
    calls: rows.length,
    ok,
    failed,
    successRate: rows.length > 0 ? Math.round((ok / rows.length) * 1000) / 10 : null,
    errors,
  }
}

/** Health snapshot from telemetry. Never throws — returns an empty snapshot on error. */
export async function getMetaMcpHealth(): Promise<MetaMcpHealth> {
  const empty: MetaMcpHealthWindow = { calls: 0, ok: 0, failed: 0, successRate: null, errors: {} }
  try {
    const since7d = new Date(Date.now() - 7 * 86400_000)
    const rows: Array<{ toolName: string; success: boolean; errorCode: string | null; ts: Date }> =
      await db.agentToolEvent.findMany({
        where: { ts: { gte: since7d } },
        select: { toolName: true, success: true, errorCode: true, ts: true },
        orderBy: { ts: 'desc' },
        take: 2000,
      })
    const meta = rows.filter((r) => isMetaTool(r.toolName))
    const cutoff24 = Date.now() - 86400_000
    const last24 = meta.filter((r) => r.ts.getTime() >= cutoff24)

    const lastSuccess = meta.find((r) => r.success)
    const lastFailure = meta.find((r) => !r.success)

    return {
      last24h: windowFrom(last24),
      last7d: windowFrom(meta),
      lastSuccessAt: lastSuccess?.ts.toISOString() ?? null,
      lastFailureAt: lastFailure?.ts.toISOString() ?? null,
      lastError: lastFailure ? { code: lastFailure.errorCode ?? null, toolName: lastFailure.toolName } : null,
    }
  } catch {
    return { last24h: empty, last7d: empty, lastSuccessAt: null, lastFailureAt: null, lastError: null }
  }
}

/**
 * Fire a throttled owner ntfy that the Meta Ads connection needs re-authing.
 * Called from the bridge's terminal auth-failure path; at most once per 6h so a
 * burst of failing calls doesn't spam the owner. Fail-open, never throws.
 */
export async function maybeAlertMetaMcpAuthExpiry(): Promise<void> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: KV_LAST_AUTH_ALERT } })
    const last = row?.value ? Date.parse(row.value) : 0
    if (Number.isFinite(last) && Date.now() - last < AUTH_ALERT_THROTTLE_MS) return

    await db.agentKvSetting.upsert({
      where: { key: KV_LAST_AUTH_ALERT },
      create: { key: KV_LAST_AUTH_ALERT, value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    await notifyOwner({
      tier: 2,
      title: 'Meta Ads সংযোগ',
      message: 'Meta Ads MCP-র লগইন মেয়াদ শেষ — /agent/growth পেজে গিয়ে আবার Connect চাপুন, তাহলে অ্যাড রিপোর্ট আবার চলবে।',
      category: 'urgent',
      actionUrl: '/agent/growth',
    })
  } catch {
    /* alerting is best-effort */
  }
}
