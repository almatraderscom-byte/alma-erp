import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getCostDashboardData } from '@/agent/lib/cost-dashboard'
import { isAgentCostDbError } from '@/agent/lib/cost-db'
import { captureAgentError } from '@/agent/lib/sentry'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  try {
    const data = await getCostDashboardData()
    return Response.json(data)
  } catch (err) {
    console.error('[assistant/costs/summary]', err)
    void captureAgentError(err, 'costs.summary_failed', { route: 'costs/summary' })
    if (isAgentCostDbError(err)) {
      return Response.json({
        error: 'agent_db_not_migrated',
        message: 'Cost dashboard tables missing. Run: npx prisma migrate deploy',
      }, { status: 503 })
    }
    return Response.json({
      error: 'server_error',
      message: err instanceof Error ? err.message : 'Cost summary failed',
    }, { status: 500 })
  }
}
