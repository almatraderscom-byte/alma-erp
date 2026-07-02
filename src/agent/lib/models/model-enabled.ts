/**
 * Per-model ON/OFF — owner toggles on the Monitor page (agent_kv_settings, no
 * redeploy). A model switched OFF is unusable EVERYWHERE — even a chat session
 * that has it pinned silently falls back to an enabled model (Gemini → DeepSeek
 * preference), and the head tells the owner why in one line.
 */
import { prisma } from '@/lib/prisma'
import { MODEL_REGISTRY } from '@/agent/lib/models/registry'

export const MODEL_ENABLED_KV_KEY = 'model.enabled'

/** Fallback preference when a chosen model is OFF. */
const FALLBACK_ORDER = ['gemini-3.1-pro', 'or-deepseek-v4-flash', 'gemini-3.5-flash', 'or-qwen3-max']

export type ModelEnabledMap = Record<string, boolean>

export function parseModelEnabledMap(value: string | null | undefined): ModelEnabledMap {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as ModelEnabledMap
  } catch {
    return {}
  }
}

/** Absent key = enabled. */
export function isModelEnabledSync(modelId: string, map: ModelEnabledMap): boolean {
  return map[modelId] !== false
}

export async function getModelEnabledMap(): Promise<ModelEnabledMap> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: MODEL_ENABLED_KV_KEY } })
    return parseModelEnabledMap(row?.value)
  } catch {
    return {} // fail-open: a KV glitch must never take models down
  }
}

export async function isModelEnabled(modelId: string): Promise<boolean> {
  return isModelEnabledSync(modelId, await getModelEnabledMap())
}

/**
 * The single question every direct-Anthropic caller must ask: is Claude usable
 * right now? False when ANTHROPIC_HEAD_DOWN is on (env, default) OR the owner
 * switched the model OFF on the Monitor. The Monitor toggle is the owner's
 * kill-switch — it must win everywhere until he flips it back on.
 */
export async function isAnthropicAllowed(modelId = 'claude-sonnet-4-6'): Promise<boolean> {
  if (process.env.ANTHROPIC_HEAD_DOWN !== 'false') return false
  return isModelEnabled(modelId)
}

export async function setModelEnabled(modelId: string, enabled: boolean): Promise<ModelEnabledMap> {
  const map = await getModelEnabledMap()
  const next: ModelEnabledMap = { ...map }
  if (enabled) delete next[modelId]
  else next[modelId] = false

  // Never allow EVERY model to be off — at least one fallback must survive.
  const anyEnabled = MODEL_REGISTRY.some((m) => isModelEnabledSync(m.id, next))
  if (!anyEnabled) throw new Error('all_models_disabled')

  await prisma.agentKvSetting.upsert({
    where: { key: MODEL_ENABLED_KV_KEY },
    create: { key: MODEL_ENABLED_KV_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  return next
}

/**
 * If `modelId` is OFF, return the first enabled fallback (Gemini → DeepSeek →
 * Flash → Qwen → any enabled registry model). Returns null when the model is
 * enabled (no change needed).
 */
export async function resolveEnabledFallback(modelId: string): Promise<string | null> {
  const map = await getModelEnabledMap()
  if (isModelEnabledSync(modelId, map)) return null
  for (const fb of FALLBACK_ORDER) {
    if (fb !== modelId && isModelEnabledSync(fb, map)) return fb
  }
  const any = MODEL_REGISTRY.find((m) => m.id !== modelId && isModelEnabledSync(m.id, map))
  return any?.id ?? null
}
