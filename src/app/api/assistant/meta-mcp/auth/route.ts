import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { buildAuthorizationUrl, isMetaMcpEnvEnabled, setMetaMcpScopeTier } from '@/agent/lib/meta-mcp/oauth'

export const runtime = 'nodejs'

/**
 * Step 1 of the one-time "Connect Meta Ads" flow (Phase MA1 — GSC pattern).
 * Discovers Meta's MCP authorization server, registers/loads the OAuth client,
 * and redirects the owner to Meta's Business consent dialog with PKCE. The
 * scope tier comes from kv meta_mcp_scope_tier (MA1 default: read-only).
 */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  if (!isMetaMcpEnvEnabled()) {
    return Response.json(
      { error: 'meta_mcp_disabled', detail: 'META_MCP_ENABLED সার্ভারে সেট করা নেই।' },
      { status: 503 },
    )
  }

  try {
    // MA3 tier upgrade: ?tier=write|financial re-connects at a higher scope so
    // the owner can draft campaigns (write) or edit budgets (financial). Default
    // read — MA1 stays read-only unless the owner explicitly upgrades.
    const tierParam = req.nextUrl.searchParams.get('tier')
    if (tierParam) await setMetaMcpScopeTier(tierParam)
    const authUrl = await buildAuthorizationUrl(req.nextUrl.origin)
    return Response.redirect(authUrl)
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'unknown'
    console.error('[meta-mcp/auth] authorize-url build failed:', detail)
    return Response.json({ error: 'meta_mcp_auth_failed', detail }, { status: 502 })
  }
}
