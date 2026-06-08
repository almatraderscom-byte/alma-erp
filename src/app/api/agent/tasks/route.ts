import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { ListTasksQuerySchema, CreateTaskBodySchema } from '@/lib/agent-api/schemas/tasks.schema'
import * as svc from '@/lib/agent-api/services/tasks.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = ListTasksQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const { status, assigned_to, due_before, limit } = parsed.data
  const data = await svc.listTasks({ status, assignedTo: assigned_to, dueBefore: due_before, limit })
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CreateTaskBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'task.created', null, body.data, () => svc.createTask(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
