import { prisma } from '@/lib/prisma'

export type CameraHeartbeatComponent = 'bridge' | 'listener'

export const CAMERA_HEARTBEAT_WRITE_INTERVAL_MS = 30_000
const globalHealth = globalThis as unknown as { almaCameraHeartbeatWrites?: Map<string, number> }
const recentWrites = globalHealth.almaCameraHeartbeatWrites ?? new Map<string, number>()
globalHealth.almaCameraHeartbeatWrites = recentWrites

function safePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'unknown'
}

export function cameraHeartbeatKey(component: CameraHeartbeatComponent, room?: string): string {
  return component === 'bridge'
    ? 'camera_health:bridge:last_seen_at'
    : `camera_health:listener:${safePart(room ?? 'unknown')}:last_seen_at`
}

export function cameraHeartbeatFresh(value: string | null, nowMs: number, staleAfterMs: number): boolean {
  if (!value) return false
  const seenAt = Date.parse(value)
  return Number.isFinite(seenAt) && nowMs - seenAt <= staleAfterMs
}

/** Best-effort and write-throttled: health telemetry must never break media traffic. */
export async function recordCameraHeartbeat(args: {
  component: CameraHeartbeatComponent
  room?: string
  now?: Date
  force?: boolean
}): Promise<{ recorded: boolean; key: string; at: string }> {
  const now = args.now ?? new Date()
  const key = cameraHeartbeatKey(args.component, args.room)
  const lastWrite = recentWrites.get(key) ?? 0
  if (!args.force && now.getTime() - lastWrite < CAMERA_HEARTBEAT_WRITE_INTERVAL_MS) {
    return { recorded: false, key, at: now.toISOString() }
  }
  try {
    await prisma.agentKvSetting.upsert({
      where: { key },
      create: { key, value: now.toISOString() },
      update: { value: now.toISOString() },
    })
    recentWrites.set(key, now.getTime())
    return { recorded: true, key, at: now.toISOString() }
  } catch {
    return { recorded: false, key, at: now.toISOString() }
  }
}
