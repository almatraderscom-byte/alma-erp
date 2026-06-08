import { NextRequest, NextResponse } from 'next/server'
import { guardAgentRequest } from '@/lib/agent-api/guard'
import { agentWrite, agentErrorResponse } from '@/lib/agent-api/route-handler'

export const dynamic = 'force-dynamic'

import { ListEmployeesQuerySchema, CreateEmployeeBodySchema } from '@/lib/agent-api/schemas/employees.schema'
import * as svc from '@/lib/agent-api/services/employees.service'

export async function GET(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const parsed = ListEmployeesQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const { active, limit, search } = parsed.data
  const data = await svc.listEmployees({ active: active === 'true' ? true : active === 'false' ? false : undefined, limit, search })
  return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
  const denied = guardAgentRequest(req)
  if (denied) return denied
  const body = CreateEmployeeBodySchema.safeParse(await req.json())
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 })
  try {
    const result = await agentWrite(req, 'employee.created', null, body.data, () => svc.createEmployee(body.data))
    return NextResponse.json(result, { status: 201 })
  } catch (e) { return agentErrorResponse(e) }
}
