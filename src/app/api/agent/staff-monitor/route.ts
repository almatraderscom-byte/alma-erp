import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getStaffMonitorData, getStaffMonitorForDate } from '@/agent/lib/staff-monitor-data'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const date = req.nextUrl.searchParams.get('date')?.trim()

  try {
    const data = date ? await getStaffMonitorForDate(date) : await getStaffMonitorData()
    return Response.json(data)
  } catch (err) {
    console.error('[agent/staff-monitor]', err)
    return Response.json({
      error: 'server_error',
      message: err instanceof Error ? err.message : 'Staff monitor failed',
    }, { status: 500 })
  }
}
