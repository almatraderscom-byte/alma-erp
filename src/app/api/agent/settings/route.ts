import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import * as svc from '@/lib/agent-api/services/settings.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const data = await svc.getSettings()
  return NextResponse.json({ data })
}
