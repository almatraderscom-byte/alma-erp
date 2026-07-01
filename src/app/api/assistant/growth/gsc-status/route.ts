import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getGscClientCreds, getGscConnection, clearGscConnection, listSites } from '@/agent/lib/gsc'

export const runtime = 'nodejs'

/** Whether the owner has connected Google Search Console (for the growth UI badge/button). */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const configured = Boolean(getGscClientCreds())
  const conn = configured ? await getGscConnection() : null

  // When connected, best-effort list the accessible properties so the owner can
  // confirm almatraders.com is present. Never fail the status call over this.
  let sites: string[] | null = null
  let sitesError: string | null = null
  if (conn) {
    try {
      sites = (await listSites()).map((s) => s.siteUrl)
    } catch (e) {
      sitesError = e instanceof Error ? e.message : 'sites_fetch_failed'
    }
  }

  return Response.json({
    configured,
    connected: Boolean(conn),
    email: conn?.email ?? null,
    connectedAt: conn?.connected_at ?? null,
    sites,
    sitesError,
  })
}

/** Disconnect — forget the stored refresh token. */
export async function DELETE(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  await clearGscConnection()
  return Response.json({ ok: true })
}
