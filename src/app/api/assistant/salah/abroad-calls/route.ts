/**
 * Owner-abroad call switch for the salah settings card.
 * GET  → { off: boolean }
 * POST { off: boolean } → { off: boolean }
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { isOwnerAbroadCallsOff, setOwnerAbroadCallsOff } from '@/lib/owner-abroad'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { error: disabled }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { error: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(token)) return { error: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { ok: true as const }
}

export async function GET(req: NextRequest) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) return auth.error

  try {
    return Response.json({ off: await isOwnerAbroadCallsOff() })
  } catch (err) {
    console.error('[assistant/salah/abroad-calls]', err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) return auth.error

  try {
    const body = await req.json().catch(() => ({})) as { off?: unknown }
    if (typeof body.off !== 'boolean') {
      return Response.json({ error: 'off (boolean) লাগবে' }, { status: 400 })
    }
    await setOwnerAbroadCallsOff(body.off)
    return Response.json({ off: body.off })
  } catch (err) {
    console.error('[assistant/salah/abroad-calls]', err)
    return Response.json({ error: 'server_error' }, { status: 500 })
  }
}
