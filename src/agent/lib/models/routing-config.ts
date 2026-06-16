/**
 * Owner-controlled model allocation.
 *
 * The owner can tune — without a redeploy — how much the expensive Opus model is
 * allowed to handle: whether it is enabled at all, its hard daily call cap, and the
 * thresholds that trigger an escalation from Sonnet → Opus. Stored in
 * `agent_kv_settings` so the monitor control dial and the router share one source.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

export interface ModelRoutingConfig {
  /** Master switch: when false, everything stays on Sonnet. */
  opusEnabled: boolean
  /** Hard cap on Opus escalations per Dhaka day (keeps Opus ≈10%). */
  opusDailyCap: number
  /** Escalate a high-risk decision only when confidence is below this (0..1). */
  opusConfidenceThreshold: number
  /** Escalate any money decision at/above this taka amount, regardless of confidence. */
  opusCriticalTaka: number
}

const KEYS = {
  opusEnabled: 'model.routing.opusEnabled',
  opusDailyCap: 'model.routing.opusDailyCap',
  opusConfidenceThreshold: 'model.routing.opusConfidenceThreshold',
  opusCriticalTaka: 'model.routing.opusCriticalTaka',
} as const

export const ROUTING_DEFAULTS: ModelRoutingConfig = {
  opusEnabled: true,
  opusDailyCap: 15,
  opusConfidenceThreshold: 0.8,
  opusCriticalTaka: 20_000,
}

export async function getModelRoutingConfig(): Promise<ModelRoutingConfig> {
  try {
    const rows = await prisma.agentKvSetting.findMany({ where: { key: { in: Object.values(KEYS) } } })
    const map = new Map(rows.map((r) => [r.key, r.value]))
    const num = (k: string, fallback: number, int = false) => {
      const raw = map.get(k)
      if (raw == null) return fallback
      const v = int ? parseInt(raw, 10) : parseFloat(raw)
      return Number.isFinite(v) ? v : fallback
    }
    return {
      opusEnabled: map.has(KEYS.opusEnabled) ? map.get(KEYS.opusEnabled) === 'true' : ROUTING_DEFAULTS.opusEnabled,
      opusDailyCap: num(KEYS.opusDailyCap, ROUTING_DEFAULTS.opusDailyCap, true),
      opusConfidenceThreshold: num(KEYS.opusConfidenceThreshold, ROUTING_DEFAULTS.opusConfidenceThreshold),
      opusCriticalTaka: num(KEYS.opusCriticalTaka, ROUTING_DEFAULTS.opusCriticalTaka, true),
    }
  } catch {
    return { ...ROUTING_DEFAULTS }
  }
}

export async function setModelRoutingConfig(patch: Partial<ModelRoutingConfig>): Promise<void> {
  const entries: Array<[string, string]> = []
  if (patch.opusEnabled !== undefined) entries.push([KEYS.opusEnabled, String(patch.opusEnabled)])
  if (patch.opusDailyCap !== undefined) entries.push([KEYS.opusDailyCap, String(Math.max(0, Math.round(patch.opusDailyCap)))])
  if (patch.opusConfidenceThreshold !== undefined) {
    const clamped = Math.min(1, Math.max(0, patch.opusConfidenceThreshold))
    entries.push([KEYS.opusConfidenceThreshold, String(clamped)])
  }
  if (patch.opusCriticalTaka !== undefined) entries.push([KEYS.opusCriticalTaka, String(Math.max(0, Math.round(patch.opusCriticalTaka)))])
  await Promise.all(
    entries.map(([key, value]) =>
      prisma.agentKvSetting.upsert({ where: { key }, create: { key, value }, update: { value } }),
    ),
  )
}

// ── Daily Opus usage counter (Dhaka day) ──────────────────────────────────────

function opusCounterKey(ymd: string = todayYmdDhaka()): string {
  return `model.opus.used.${ymd}`
}

export async function getOpusUsedToday(): Promise<number> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: opusCounterKey() } })
    return row ? parseInt(row.value, 10) || 0 : 0
  } catch {
    return 0
  }
}

export async function bumpOpusUsedToday(): Promise<number> {
  const key = opusCounterKey()
  const current = await getOpusUsedToday()
  const next = current + 1
  await prisma.agentKvSetting.upsert({ where: { key }, create: { key, value: String(next) }, update: { value: String(next) } })
  return next
}
