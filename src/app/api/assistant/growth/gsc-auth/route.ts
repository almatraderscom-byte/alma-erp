import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getGscClientCreds, getGscRedirectUri, GSC_SCOPE } from '@/agent/lib/gsc'

export const runtime = 'nodejs'

/**
 * Step 1 of the one-time "Connect Google Search Console" flow. Redirects the
 * owner to Google's consent screen. After approval Google redirects back to the
 * callback route, which stores the refresh token. access_type=offline +
 * prompt=consent guarantee a refresh token (Google only sends it on fresh consent).
 */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const creds = getGscClientCreds()
  if (!creds) {
    return Response.json(
      { error: 'gsc_not_configured', detail: 'GSC_CLIENT_ID/SECRET বা GOOGLE_DRIVE_CLIENT_ID/SECRET সেট করা নেই।' },
      { status: 503 },
    )
  }

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', creds.clientId)
  authUrl.searchParams.set('redirect_uri', getGscRedirectUri())
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', `${GSC_SCOPE} https://www.googleapis.com/auth/userinfo.email`)
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  authUrl.searchParams.set('include_granted_scopes', 'true')

  return Response.redirect(authUrl.toString())
}
