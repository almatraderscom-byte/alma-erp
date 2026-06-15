import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getTrustDecision } from '@/agent/lib/trust-engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (token !== process.env.AGENT_INTERNAL_TOKEN) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { domain, actionPattern, businessId, costEstimate } = await req.json()
  const decision = await getTrustDecision(domain, actionPattern, businessId, costEstimate)
  return Response.json(decision)
}
