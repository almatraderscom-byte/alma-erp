import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getTrustDecision } from '@/agent/lib/trust-engine'
import { extractBearerToken, verifyAgentInternalToken } from '@/lib/agent-internal-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { domain, actionPattern, businessId, costEstimate } = await req.json()
  const decision = await getTrustDecision(domain, actionPattern, businessId, costEstimate)
  return Response.json(decision)
}
