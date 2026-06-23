import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { exchangeCodeForTokens, saveDriveConnection } from '@/agent/lib/drive'

export const runtime = 'nodejs'

/**
 * Step 2 of the "Connect Google Drive" flow. Google redirects here with a code;
 * we exchange it for a refresh token and store it. Then we bounce the owner back
 * to the Creative Studio with a status flag. The session cookie rides along on
 * this top-level redirect, so the owner-only guard still applies.
 */
function studioRedirect(req: NextRequest, status: string): Response {
  const base = (process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? req.nextUrl.origin).replace(/\/$/, '')
  return Response.redirect(`${base}/agent?studio=1&drive=${status}`)
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const err = req.nextUrl.searchParams.get('error')
  if (err) {
    console.warn('[drive-auth/callback] consent denied:', err)
    return studioRedirect(req, 'denied')
  }

  const code = req.nextUrl.searchParams.get('code')
  if (!code) return studioRedirect(req, 'no_code')

  try {
    const conn = await exchangeCodeForTokens(code)
    await saveDriveConnection(conn)
    console.log('[drive-auth/callback] connected:', conn.email || '(email hidden)')
    return studioRedirect(req, 'connected')
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'unknown'
    console.error('[drive-auth/callback] exchange failed:', detail)
    return studioRedirect(req, 'error')
  }
}
