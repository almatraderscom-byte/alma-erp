// Growth Autopilot — owner-tunable settings (agent_kv_settings, no redeploy).
//
// Two independent switches on top of the global AGENT_ENABLED kill switch:
//   • growth.autopilot   — master for the growth module's autonomous crons
//                          (scheduled publish, weekly digest). Default ON:
//                          publishing only ever touches owner-APPROVED rows,
//                          so it is safe-by-construction.
//   • growth.rankTracking — the weekly SERP pull, which spends Oxylabs credits.
//                          Default OFF so recurring paid pulls are opt-in.
import { prisma } from '@/lib/prisma'

export const GROWTH_AUTOPILOT_KEY = 'growth.autopilot'
export const GROWTH_RANK_TRACKING_KEY = 'growth.rankTracking'

// Max keywords a single weekly SERP pull will spend on — hard cost ceiling.
export const RANK_TRACKING_MAX_KEYWORDS = 15

async function readFlag(key: string, defaultOn: boolean): Promise<boolean> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key } })
    if (!row?.value) return defaultOn
    const v = row.value.trim().toLowerCase()
    if (['on', 'true', '1', 'yes', 'enabled'].includes(v)) return true
    if (['off', 'false', '0', 'no', 'disabled'].includes(v)) return false
    return defaultOn
  } catch {
    return defaultOn
  }
}

async function writeFlag(key: string, on: boolean): Promise<void> {
  const value = on ? 'on' : 'off'
  await prisma.agentKvSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}

/** Master switch for growth autonomous crons (publish + digest). Default ON. */
export function isGrowthAutopilotOn(): Promise<boolean> {
  return readFlag(GROWTH_AUTOPILOT_KEY, true)
}

export function setGrowthAutopilot(on: boolean): Promise<void> {
  return writeFlag(GROWTH_AUTOPILOT_KEY, on)
}

/** Weekly SERP rank-tracking pull (spends credits). Default OFF. */
export function isRankTrackingOn(): Promise<boolean> {
  return readFlag(GROWTH_RANK_TRACKING_KEY, false)
}

export function setRankTracking(on: boolean): Promise<void> {
  return writeFlag(GROWTH_RANK_TRACKING_KEY, on)
}
