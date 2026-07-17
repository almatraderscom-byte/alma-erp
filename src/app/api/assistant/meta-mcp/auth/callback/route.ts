import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { handleAuthorizationCallback, isMetaMcpEnvEnabled } from '@/agent/lib/meta-mcp/oauth'

export const runtime = 'nodejs'

/**
 * Step 2 of the "Connect Meta Ads" flow. Meta redirects here with code+state;
 * we look up the PKCE verifier by state, exchange for tokens, store them in
 * agent_kv_settings, and bounce the owner back to the growth connections page
 * with a status flag (mirrors gsc-auth/callback).
 */
function growthRedirect(req: NextRequest, status: string): Response {
  const base = (process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? req.nextUrl.origin).replace(/\/$/, '')
  return Response.redirect(`${base}/agent/growth?meta=${status}`)
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  if (!isMetaMcpEnvEnabled()) return growthRedirect(req, 'disabled')

  const err = req.nextUrl.searchParams.get('error')
  if (err) {
    console.warn('[meta-mcp/auth/callback] consent denied:', err)
    return growthRedirect(req, 'denied')
  }

  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  if (!code || !state) return growthRedirect(req, 'no_code')

  try {
    const tokens = await handleAuthorizationCallback(code, state)
    console.log('[meta-mcp/auth/callback] connected, tier:', tokens.tier)
    return growthRedirect(req, 'connected')
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'unknown'
    console.error('[meta-mcp/auth/callback] exchange failed:', detail)
    return growthRedirect(req, 'error')
  }
}
