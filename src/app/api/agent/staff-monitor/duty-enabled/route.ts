import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  cancelTodayDutyTodo,
  getResolvedDutyEnabledMap,
  isCriticalDuty,
  seedDutyTodoIfMissing,
  setDutyEnabled,
  DUTY_TOGGLE_LOCKED,
} from '@/agent/lib/duty-enabled'
import { DAILY_DUTIES } from '@/agent/lib/agent-duties'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function GET(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied

  const dutyEnabled = await getResolvedDutyEnabledMap()
  return Response.json({ dutyEnabled })
}

export async function PATCH(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied

  let body: { dutyKey?: string; enabled?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const dutyKey = body.dutyKey?.trim()
  if (!dutyKey) {
    return Response.json({ error: 'dutyKey required' }, { status: 400 })
  }
  if (typeof body.enabled !== 'boolean') {
    return Response.json({ error: 'enabled must be boolean' }, { status: 400 })
  }
  if (!DAILY_DUTIES.some((d) => d.duty === dutyKey)) {
    return Response.json({ error: 'unknown_duty' }, { status: 400 })
  }
  if (DUTY_TOGGLE_LOCKED.has(dutyKey)) {
    return Response.json({ error: 'duty_locked' }, { status: 403 })
  }

  try {
    await setDutyEnabled(dutyKey, body.enabled)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'update_failed'
    return Response.json({ error: msg }, { status: 403 })
  }

  const today = todayYmdDhaka()
  let todosCancelled = 0
  let todoSeeded = false
  if (!body.enabled) {
    todosCancelled = await cancelTodayDutyTodo(dutyKey, today)
  } else {
    todoSeeded = await seedDutyTodoIfMissing(dutyKey, today)
  }

  const dutyEnabled = await getResolvedDutyEnabledMap()
  const critical = isCriticalDuty(dutyKey)

  return Response.json({
    dutyKey,
    enabled: body.enabled,
    critical,
    dutyEnabled,
    todosCancelled,
    todoSeeded,
  })
}
