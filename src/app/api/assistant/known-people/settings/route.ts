// Entrance-watch settings (owner-only): device id, enable flag, active window,
// alert cooldown. All stored in agent_kv_settings — no redeploy needed.
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getEntranceSettings, kvSetEntrance } from '@/agent/lib/entrance-watch'

export const runtime = 'nodejs'
export const maxDuration = 30

interface SettingsBody {
  deviceId?: string
  enabled?: boolean
  startHm?: string
  endHm?: string
  cooldownMin?: number
}

const HM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const session = await getServerSession(authOptions)
  if (!session?.user || !isSystemOwner(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: SettingsBody
  try {
    body = (await req.json()) as SettingsBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  if (body.deviceId !== undefined) await kvSetEntrance('entrance_camera_device_id', body.deviceId.trim())
  if (body.enabled !== undefined) await kvSetEntrance('entrance_watch_enabled', body.enabled ? 'on' : 'off')
  if (body.startHm !== undefined && HM_RE.test(body.startHm)) await kvSetEntrance('entrance_watch_start_hm', body.startHm)
  if (body.endHm !== undefined && HM_RE.test(body.endHm)) await kvSetEntrance('entrance_watch_end_hm', body.endHm)
  if (body.cooldownMin !== undefined && Number.isFinite(body.cooldownMin) && body.cooldownMin > 0) {
    await kvSetEntrance('entrance_alert_cooldown_min', String(Math.round(body.cooldownMin)))
  }

  return NextResponse.json({ ok: true, settings: await getEntranceSettings() })
}
