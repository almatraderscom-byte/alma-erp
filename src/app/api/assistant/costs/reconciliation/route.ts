/**
 * GET /api/assistant/costs/reconciliation — monthly local-estimate vs
 * provider-published bill reconciliation (owner). Read-only.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { computeMonthlyReconciliation } from '@/agent/lib/cost-reconciliation'
import { captureAgentError } from '@/agent/lib/sentry'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  try {
    return Response.json(await computeMonthlyReconciliation())
  } catch (err) {
    console.error('[assistant/costs/reconciliation]', err)
    void captureAgentError(err, 'costs.reconciliation_failed', { route: 'costs/reconciliation' })
    return Response.json(
      { error: 'server_error', message: err instanceof Error ? err.message : 'Reconciliation failed' },
      { status: 500 },
    )
  }
}
