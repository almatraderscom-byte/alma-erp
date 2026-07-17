import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  clearMetaMcpConnection,
  getMetaMcpConnection,
  getMetaMcpEndpoint,
  getMetaMcpScopeTier,
  isMetaMcpEnvEnabled,
  isMetaMcpKvEnabled,
} from '@/agent/lib/meta-mcp/oauth'
import { getRemoteToolCatalog, META_MCP_READ_TOOL_NAMES } from '@/agent/lib/meta-mcp/bridge'
import { metaMcpCallTool } from '@/agent/lib/meta-mcp/client'

export const runtime = 'nodejs'
export const maxDuration = 60

type TokenHealth = 'none' | 'valid' | 'expiring_soon' | 'refreshable' | 'reconnect_needed'

/**
 * "Connect Meta Ads" status for the growth UI card (Phase MA1):
 * enabled? connected? which tier? which ad account(s)? token health.
 * Live probes (tool catalog + ad accounts) are best-effort — never fail the call.
 */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const envEnabled = isMetaMcpEnvEnabled()
  const kvEnabled = await isMetaMcpKvEnabled()
  const conn = await getMetaMcpConnection()
  const tier = await getMetaMcpScopeTier()

  let tokenHealth: TokenHealth = 'none'
  if (conn) {
    const remaining = conn.expires_at > 0 ? conn.expires_at - Date.now() : Number.POSITIVE_INFINITY
    if (remaining > 10 * 60 * 1000) tokenHealth = 'valid'
    else if (remaining > 0) tokenHealth = 'expiring_soon'
    else tokenHealth = conn.refresh_token ? 'refreshable' : 'reconnect_needed'
  }

  // Best-effort live probes, only when enabled + connected.
  let remoteToolCount: number | null = null
  let adAccounts: Array<{ id?: string; name?: string }> | null = null
  let probeError: string | null = null
  if (envEnabled && kvEnabled && conn) {
    try {
      const catalog = await getRemoteToolCatalog()
      remoteToolCount = catalog?.tools.length ?? null
      const result = await metaMcpCallTool('ads_get_ad_accounts', {})
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n')
      const parsed: unknown = result.structuredContent ?? (text ? JSON.parse(text) : null)
      // Tolerant extraction — Meta's exact shape may evolve; show what we can.
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown[] }).data)
          ? (parsed as { data: unknown[] }).data
          : null
      if (list) {
        adAccounts = list.slice(0, 10).map((a) => {
          const acc = (a ?? {}) as Record<string, unknown>
          return {
            id: typeof acc.id === 'string' ? acc.id : typeof acc.account_id === 'string' ? acc.account_id : undefined,
            name: typeof acc.name === 'string' ? acc.name : undefined,
          }
        })
      }
    } catch (e) {
      probeError = e instanceof Error ? e.message : 'probe_failed'
    }
  }

  return Response.json({
    envEnabled,
    kvEnabled,
    enabled: envEnabled && kvEnabled,
    endpoint: getMetaMcpEndpoint(),
    connected: Boolean(conn),
    tier,
    scope: conn?.scope ?? null,
    connectedAt: conn?.connected_at ?? null,
    tokenHealth,
    registeredReadTools: META_MCP_READ_TOOL_NAMES.length,
    remoteToolCount,
    adAccounts,
    probeError,
  })
}

/** Disconnect — forget the stored tokens (revoke fully in Business Suite → Business Integrations). */
export async function DELETE(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  await clearMetaMcpConnection()
  return Response.json({ ok: true })
}
