/**
 * CS4 — owner-taste store (deterministic weighting, kv-backed, no LLM).
 * ভালো/বাদ feedback on gallery items bumps the SCENE the item was shot in;
 * the family chain then favours liked scenes via pickSceneWeighted.
 * Also home to the two studio settings the owner can flip without a redeploy.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const WEIGHTS_KEY = 'studio_scene_weights'
export const QC_LEVEL_KEY = 'agent_qc_level'
export const NOTIFY_KEY = 'studio_notify_on_done'

export async function readSceneWeights(): Promise<Record<string, number>> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: WEIGHTS_KEY } })
    const parsed = row ? JSON.parse(row.value) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** good:+1 / bad:-1, clamped to [-3, 5] (−3 disables the scene). */
export async function bumpSceneWeight(sceneId: string, verdict: 'good' | 'bad'): Promise<number> {
  const weights = await readSceneWeights()
  const next = Math.max(-3, Math.min(5, (Number(weights[sceneId]) || 0) + (verdict === 'good' ? 1 : -1)))
  weights[sceneId] = next
  await db.agentKvSetting.upsert({
    where: { key: WEIGHTS_KEY },
    update: { value: JSON.stringify(weights) },
    create: { key: WEIGHTS_KEY, value: JSON.stringify(weights) },
  })
  return next
}

export async function readKv(key: string): Promise<string | null> {
  const row = await db.agentKvSetting.findUnique({ where: { key } }).catch(() => null)
  return row?.value ?? null
}

export async function writeKv(key: string, value: string): Promise<void> {
  await db.agentKvSetting.upsert({ where: { key }, update: { value }, create: { key, value } })
}
