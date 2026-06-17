import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getGeoFenceMonitoringEnabled, setGeoFenceMonitoringEnabled } from '@/agent/lib/geo-fence-settings'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function GET(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied

  const enabled = await getGeoFenceMonitoringEnabled()
  return Response.json({ enabled })
}

export async function PATCH(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied

  let body: { enabled?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (typeof body.enabled !== 'boolean') {
    return Response.json({ error: 'enabled must be boolean' }, { status: 400 })
  }

  await setGeoFenceMonitoringEnabled(body.enabled)
  return Response.json({ enabled: body.enabled })
}
