import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { CompleteTaskBodySchema } from '@/lib/agent-api/schemas/tasks.schema'
import * as svc from '@/lib/agent-api/services/tasks.service'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CompleteTaskBodySchema.safeParse(await req.json().catch(() => ({})))
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'task.completed', params.id, body.data, () => svc.completeTask(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}
