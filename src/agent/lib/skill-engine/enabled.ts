/**
 * Skill Engine V2 — the on/off switch, KV-tunable (no redeploy) like `live_browser_enabled`.
 * Reads the `skill_engine_enabled` KV first; falls back to the SKILL_ENGINE_ENABLED env.
 * Default OFF. Fail-open to OFF — a KV hiccup must never silently enable skills.
 */
import { prisma } from '@/lib/prisma'

export const SKILL_ENGINE_ENABLED_KEY = 'skill_engine_enabled'

export async function isSkillEngineEnabled(): Promise<boolean> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: SKILL_ENGINE_ENABLED_KEY } })
    if (row?.value != null) return row.value === 'true'
  } catch {
    /* no DB (tests) → fall through to env */
  }
  return process.env.SKILL_ENGINE_ENABLED === 'true'
}

/** Owner toggle (no redeploy). Writes the KV switch. */
export async function setSkillEngineEnabled(on: boolean): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: SKILL_ENGINE_ENABLED_KEY },
    create: { key: SKILL_ENGINE_ENABLED_KEY, value: String(on) },
    update: { value: String(on) },
  })
}
