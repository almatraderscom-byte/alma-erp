import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  STAFF_TASK_TOGGLES,
  getResolvedStaffToggles,
  isValidStaffToggleKey,
  setStaffToggle,
} from '@/agent/lib/staff-task-toggle'

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

  const toggles = await getResolvedStaffToggles()
  return Response.json({ toggles, defs: STAFF_TASK_TOGGLES })
}

export async function PATCH(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied

  let body: { key?: string; enabled?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const key = body.key?.trim()
  if (!key || !isValidStaffToggleKey(key)) {
    return Response.json({ error: 'unknown_key' }, { status: 400 })
  }
  if (typeof body.enabled !== 'boolean') {
    return Response.json({ error: 'enabled must be boolean' }, { status: 400 })
  }

  const toggles = await setStaffToggle(key, body.enabled)
  return Response.json({ key, enabled: body.enabled, toggles })
}
