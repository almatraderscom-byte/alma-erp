import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { runHealthScan } from '@/lib/diagnostic/health-scan'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const bearer = req.headers.get('authorization')?.replace('Bearer ', '')
  const internalToken = process.env.AGENT_INTERNAL_TOKEN
  const isInternalAuth = bearer && internalToken && bearer === internalToken

  if (!isInternalAuth) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    const report = await runHealthScan()
    return Response.json(report)
  } catch (err) {
    console.error('[agent/health-scan]', err)
    return Response.json({
      error: 'scan_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  return GET(req)
}
