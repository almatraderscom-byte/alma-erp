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
import { isKnownModelId, isAnthropicModel, getModel, DEFAULT_MODEL_ID } from '@/agent/lib/models/registry'

export type TaskTier = 'critical' | 'heavy' | 'light'

export interface ModelRoutingConfig {
  /** Master switch: when false, everything stays on Sonnet. */
  opusEnabled: boolean
  /** Hard cap on Opus escalations per Dhaka day (keeps Opus ≈10%). */
  opusDailyCap: number
  /** Escalate a high-risk decision only when confidence is below this (0..1). */
  opusConfidenceThreshold: number
  /** Escalate any money decision at/above this taka amount, regardless of confidence. */
  opusCriticalTaka: number
  /** Which premium model the gate escalates to (owner-chosen — cost vs power). */
  criticalModelId: string
  /** Sub-agent / tuktak LIGHT tier (OpenRouter cheap). */
  lightModelId: string
  /** Sub-agent HEAVY-CONTEXT tier (OpenRouter mid). */
  heavyModelId: string
  /** Sub-agent CRITICAL tier — Claude only (CS/finance/staff/scheduler). */
  criticalSubagentModelId: string
  /**
   * Owner's DEFAULT head model — the model that runs as head (and does ALL the
   * work, no cost-triage) for a new/unpinned conversation and for Telegram. Owner
   * rule 2026-07-18: "ami jei model select kori setai head hoye shob kaj koruk,
   * normally Grok" → default Grok 4.20. Owner-tunable, no redeploy. Must be a
   * head-pickable, tool-using model. Picking 'auto' in the model selector still
   * restores the cheap cost-routing for that conversation.
   */
  defaultHeadModelId: string
}

const KEYS = {
  opusEnabled: 'model.routing.opusEnabled',
  opusDailyCap: 'model.routing.opusDailyCap',
  opusConfidenceThreshold: 'model.routing.opusConfidenceThreshold',
  opusCriticalTaka: 'model.routing.opusCriticalTaka',
  criticalModelId: 'model.routing.criticalModelId',
  lightModelId: 'model.routing.tier.lightModelId',
  heavyModelId: 'model.routing.tier.heavyModelId',
  criticalSubagentModelId: 'model.routing.tier.criticalSubagentModelId',
  defaultHeadModelId: 'model.routing.defaultHeadModelId',
} as const

/** Fallback head when nothing is configured — owner rule 2026-07-18: Grok 4.20. */
export const DEFAULT_HEAD_MODEL_ID = 'xai-grok-4.20'

/** A model id is usable as the owner's head only if it drives the full toolset. */
function isValidHeadModelId(id: string | undefined | null): boolean {
  if (!id || !isKnownModelId(id)) return false
  const m = getModel(id)
  return m.supportsTools === true && m.headPickable !== false
}

export const ROUTING_DEFAULTS: ModelRoutingConfig = {
  opusEnabled: true,
  opusDailyCap: 15,
  opusConfidenceThreshold: 0.8,
  opusCriticalTaka: 20_000,
  criticalModelId: 'claude-opus-4-8',
  lightModelId: 'or-glm-4-32b',
  heavyModelId: 'or-gemini-2.5-flash-lite',
  criticalSubagentModelId: DEFAULT_MODEL_ID,
  defaultHeadModelId: DEFAULT_HEAD_MODEL_ID,
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
    const rawModel = map.get(KEYS.criticalModelId)
    const criticalModelId = rawModel && isKnownModelId(rawModel) ? rawModel : ROUTING_DEFAULTS.criticalModelId

    const rawLight = map.get(KEYS.lightModelId)
    const lightModelId = rawLight && isKnownModelId(rawLight) ? rawLight : ROUTING_DEFAULTS.lightModelId

    const rawHeavy = map.get(KEYS.heavyModelId)
    const heavyModelId = rawHeavy && isKnownModelId(rawHeavy) ? rawHeavy : ROUTING_DEFAULTS.heavyModelId

    let criticalSubagentModelId = ROUTING_DEFAULTS.criticalSubagentModelId
    const rawCriticalSub = map.get(KEYS.criticalSubagentModelId)
    if (rawCriticalSub && isKnownModelId(rawCriticalSub) && isAnthropicModel(rawCriticalSub)) {
      criticalSubagentModelId = rawCriticalSub
    }

    const rawDefaultHead = map.get(KEYS.defaultHeadModelId)
    const defaultHeadModelId = isValidHeadModelId(rawDefaultHead)
      ? (rawDefaultHead as string)
      : ROUTING_DEFAULTS.defaultHeadModelId

    return {
      opusEnabled: map.has(KEYS.opusEnabled) ? map.get(KEYS.opusEnabled) === 'true' : ROUTING_DEFAULTS.opusEnabled,
      opusDailyCap: num(KEYS.opusDailyCap, ROUTING_DEFAULTS.opusDailyCap, true),
      opusConfidenceThreshold: num(KEYS.opusConfidenceThreshold, ROUTING_DEFAULTS.opusConfidenceThreshold),
      opusCriticalTaka: num(KEYS.opusCriticalTaka, ROUTING_DEFAULTS.opusCriticalTaka, true),
      criticalModelId,
      lightModelId,
      heavyModelId,
      criticalSubagentModelId,
      defaultHeadModelId,
    }
  } catch {
    return { ...ROUTING_DEFAULTS }
  }
}

/**
 * The owner's DEFAULT head model id (KV-tunable, no redeploy) — used by the chat
 * route for new/unpinned conversations + Telegram, and by the head router's heavy
 * fallback. Cheap standalone reader so callers don't pull the whole config.
 */
export async function getDefaultHeadModelId(): Promise<string> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: KEYS.defaultHeadModelId } })
    return isValidHeadModelId(row?.value) ? (row!.value as string) : ROUTING_DEFAULTS.defaultHeadModelId
  } catch {
    return ROUTING_DEFAULTS.defaultHeadModelId
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
  if (patch.criticalModelId !== undefined && isKnownModelId(patch.criticalModelId)) {
    entries.push([KEYS.criticalModelId, patch.criticalModelId])
  }
  if (patch.lightModelId !== undefined && isKnownModelId(patch.lightModelId)) {
    entries.push([KEYS.lightModelId, patch.lightModelId])
  }
  if (patch.heavyModelId !== undefined && isKnownModelId(patch.heavyModelId)) {
    entries.push([KEYS.heavyModelId, patch.heavyModelId])
  }
  if (
    patch.criticalSubagentModelId !== undefined &&
    isKnownModelId(patch.criticalSubagentModelId) &&
    isAnthropicModel(patch.criticalSubagentModelId)
  ) {
    entries.push([KEYS.criticalSubagentModelId, patch.criticalSubagentModelId])
  }
  if (patch.defaultHeadModelId !== undefined && isValidHeadModelId(patch.defaultHeadModelId)) {
    entries.push([KEYS.defaultHeadModelId, patch.defaultHeadModelId])
  }
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
