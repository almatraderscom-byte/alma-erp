import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { SettingsPatchLateThresholdSchema } from '@/lib/agent-api/schemas/reports.schema'
import * as svc from '@/lib/agent-api/services/settings.service'

export async function PATCH(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = SettingsPatchLateThresholdSchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'settings.late-threshold_updated', 'global', body.data, () => svc.patchLateThreshold(body.data.lateThresholdMinutes))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
