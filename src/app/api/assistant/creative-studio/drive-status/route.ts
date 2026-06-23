import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getDriveClientCreds, getDriveConnection, clearDriveConnection } from '@/agent/lib/drive'

export const runtime = 'nodejs'

/** Whether the owner has connected Google Drive (for the Studio UI badge/button). */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const configured = Boolean(getDriveClientCreds())
  const conn = configured ? await getDriveConnection() : null
  return Response.json({
    configured,
    connected: Boolean(conn),
    email: conn?.email ?? null,
    connectedAt: conn?.connected_at ?? null,
  })
}

/** Disconnect — forget the stored refresh token. */
export async function DELETE(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  await clearDriveConnection()
  return Response.json({ ok: true })
}
