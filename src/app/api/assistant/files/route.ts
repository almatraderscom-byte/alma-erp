import { timingSafeEqual } from 'node:crypto'
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageSignedUrl } from '@/agent/lib/storage'

export const runtime = 'nodejs'

/**
 * The VPS worker (Telegram) fetches files server-to-server to re-send them as
 * native photo messages — it has no browser session. Read-only access with
 * the same internal bearer it already uses for /chat; writes stay impossible
 * (this route only ever mints signed GET URLs).
 */
function isInternalWorker(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!isInternalWorker(req)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const path = req.nextUrl.searchParams.get('path')?.trim()
  if (!path || path.includes('..')) {
    return Response.json({ error: 'invalid_path' }, { status: 400 })
  }

  const url = await agentStorageSignedUrl(path, 3600)

  // redirect=1 → serve the file directly (302 to a fresh signed URL, as a
  // download). This lets the agent hand the owner SHORT stable links instead of
  // 300-char signed JWTs — the head once corrupted a JWT while copying it into
  // a reply, producing a dead link; a short link has nothing to mistype.
  if (req.nextUrl.searchParams.get('redirect')) {
    const name = path.split('/').pop() ?? 'file'
    const sep = url.includes('?') ? '&' : '?'
    return Response.redirect(`${url}${sep}download=${encodeURIComponent(name)}`, 302)
  }
  return Response.json({ url })
}
