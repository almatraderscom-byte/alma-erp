import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { PatchTaskBodySchema } from '@/lib/agent-api/schemas/tasks.schema'
import * as svc from '@/lib/agent-api/services/tasks.service'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(_req)
  if (denied) return denied
  const data = await svc.getTask(params.id)
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = PatchTaskBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'task.updated', params.id, body.data, () => svc.patchTask(params.id, body.data))
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e) }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  try {
    const result = await agentWrite(req, 'task.deleted', params.id, {}, () => svc.deleteTask(params.id))
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(result)
  } catch (e) { return agentErrorResponse(e, 409) }
}
