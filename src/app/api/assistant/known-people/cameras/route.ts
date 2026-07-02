// List the Imou cameras bound to the developer app (owner-only) so the admin
// page can offer a dropdown for picking the entrance camera.
import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { listImouCameras } from '@/agent/lib/imou-camera'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function GET() {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const session = await getServerSession(authOptions)
  if (!session?.user || !isSystemOwner(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const cameras = await listImouCameras()
    return NextResponse.json({
      cameras,
      workRoomDeviceId: process.env.IMOU_DEVICE_ID ?? '',
    })
  } catch (err) {
    return NextResponse.json(
      { cameras: [], error: err instanceof Error ? err.message : 'imou list failed' },
      { status: 200 },
    )
  }
}
