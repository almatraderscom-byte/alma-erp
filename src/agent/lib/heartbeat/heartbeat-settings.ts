/**
 * Phase 5 (autonomous heartbeat) — owner-tunable heartbeat behaviour (KV, no redeploy).
 *
 * KV key `heartbeat` holds JSON `{ enabled?, dailyHeadWakeCap?, officeHoursOnly? }`.
 *
 *   • enabled (DEFAULT false) — master toggle for the autonomous head heartbeat.
 *     OFF means the cron is a no-op: the head never self-wakes. Opt-in by design,
 *     so the owner switches it on deliberately (it costs a little each wake).
 *   • dailyHeadWakeCap (DEFAULT 6) — hard ceiling on cost-bearing head wakes per
 *     Dhaka-day. Past the cap the tick still records a cheap "pulse" entry but
 *     won't wake the head. Keeps a noisy day from running up the bill.
 *   • officeHoursOnly (DEFAULT true) — only let the head self-wake during office
 *     hours (09:30–20:00 Asia/Dhaka). Off-hours ticks are skipped entirely.
 *
 * Mirrors office-supervisor-settings: fail-safe reader (defaults on any glitch),
 * shallow-merge writer.
 */
import { prisma } from '@/lib/prisma'

export const HEARTBEAT_KV_KEY = 'heartbeat'

export interface HeartbeatSettings {
  enabled: boolean
  dailyHeadWakeCap: number
  officeHoursOnly: boolean
}

export const HEARTBEAT_DEFAULTS: HeartbeatSettings = {
  enabled: false,
  dailyHeadWakeCap: 6,
  officeHoursOnly: true,
}

function clampCap(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return HEARTBEAT_DEFAULTS.dailyHeadWakeCap
  return Math.min(Math.max(Math.round(n), 0), 48)
}

export async function getHeartbeatSettings(): Promise<HeartbeatSettings> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: HEARTBEAT_KV_KEY }, select: { value: true } })
    if (!row?.value) return { ...HEARTBEAT_DEFAULTS }
    const parsed = JSON.parse(row.value) as Partial<HeartbeatSettings>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : HEARTBEAT_DEFAULTS.enabled,
      dailyHeadWakeCap: clampCap(parsed.dailyHeadWakeCap),
      officeHoursOnly:
        typeof parsed.officeHoursOnly === 'boolean' ? parsed.officeHoursOnly : HEARTBEAT_DEFAULTS.officeHoursOnly,
    }
  } catch {
    return { ...HEARTBEAT_DEFAULTS }
  }
}

/** Shallow-merge a partial update into the stored settings; returns the merged result. */
export async function setHeartbeatSettings(patch: Partial<HeartbeatSettings>): Promise<HeartbeatSettings> {
  const current = await getHeartbeatSettings()
  const next: HeartbeatSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    dailyHeadWakeCap: patch.dailyHeadWakeCap != null ? clampCap(patch.dailyHeadWakeCap) : current.dailyHeadWakeCap,
    officeHoursOnly: typeof patch.officeHoursOnly === 'boolean' ? patch.officeHoursOnly : current.officeHoursOnly,
  }
  await prisma.agentKvSetting.upsert({
    where: { key: HEARTBEAT_KV_KEY },
    create: { key: HEARTBEAT_KV_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  return next
}
