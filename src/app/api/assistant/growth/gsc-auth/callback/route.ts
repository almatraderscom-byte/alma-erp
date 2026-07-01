import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { exchangeCodeForTokens, saveGscConnection } from '@/agent/lib/gsc'

export const runtime = 'nodejs'

/**
 * Step 2 of the "Connect Google Search Console" flow. Google redirects here with
 * a code; we exchange it for a refresh token and store it, then bounce the owner
 * back to the growth connections page with a status flag. The session cookie
 * rides along on this top-level redirect, so the owner-only guard still applies.
 */
function growthRedirect(req: NextRequest, status: string): Response {
  const base = (process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? req.nextUrl.origin).replace(/\/$/, '')
  return Response.redirect(`${base}/agent/growth?gsc=${status}`)
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const err = req.nextUrl.searchParams.get('error')
  if (err) {
    console.warn('[gsc-auth/callback] consent denied:', err)
    return growthRedirect(req, 'denied')
  }

  const code = req.nextUrl.searchParams.get('code')
  if (!code) return growthRedirect(req, 'no_code')

  try {
    const conn = await exchangeCodeForTokens(code)
    await saveGscConnection(conn)
    console.log('[gsc-auth/callback] connected:', conn.email || '(email hidden)')
    return growthRedirect(req, 'connected')
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'unknown'
    console.error('[gsc-auth/callback] exchange failed:', detail)
    return growthRedirect(req, 'error')
  }
}
