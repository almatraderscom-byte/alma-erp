/**
 * Owner-tunable office-supervisor behaviour (KV-backed, no redeploy).
 *
 * KV key `office_supervisor`: JSON `{ "autoAcceptNonCritical"?: boolean }`.
 *
 * `autoAcceptNonCritical` — when the supervisor exhausts its redo/clarify
 * attempts (MAX_AUTO_REDO / MAX_CLARIFY) and STILL can't verify or understand a
 * task:
 *   - false: escalate the task to the owner for approval — even low-stakes
 *     ones. Matches the stricter rule "1-2 চেষ্টায় না পারলে আমার কাছে পাঠাবে;
 *     আমি approve করলেই Accepted". Set this if owner wants to see everything.
 *   - true (DEFAULT): 90/10 autonomy — silently accept low-stakes unverifiable
 *     tasks as done, only escalate the critical (money/customer) ~10%. This is
 *     the default so the office manager runs autonomously without constant pings.
 */
import { prisma } from '@/lib/prisma'

export const OFFICE_SUPERVISOR_KV_KEY = 'office_supervisor'

export type OfficeSupervisorSettings = {
  autoAcceptNonCritical: boolean
}

const DEFAULTS: OfficeSupervisorSettings = {
  // 90/10 autonomy (owner decision, 2026-06): the supervisor self-resolves
  // low-stakes tasks it can't fully verify and only escalates the truly-critical
  // ~10% (money / customer-facing, via assessCriticality). Reduces the constant
  // owner pings that made the office manager feel non-autonomous. Owner-tunable
  // back to false via setAutoAcceptNonCritical if escalations are wanted again.
  autoAcceptNonCritical: true,
}

export async function getOfficeSupervisorSettings(): Promise<OfficeSupervisorSettings> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: OFFICE_SUPERVISOR_KV_KEY } })
    if (!row?.value) return { ...DEFAULTS }
    const parsed = JSON.parse(row.value) as Partial<OfficeSupervisorSettings>
    return {
      autoAcceptNonCritical:
        typeof parsed.autoAcceptNonCritical === 'boolean'
          ? parsed.autoAcceptNonCritical
          : DEFAULTS.autoAcceptNonCritical,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Owner toggle for "silently accept low-stakes unverifiable tasks". */
export async function setAutoAcceptNonCritical(on: boolean): Promise<OfficeSupervisorSettings> {
  const current = await getOfficeSupervisorSettings()
  const next: OfficeSupervisorSettings = { ...current, autoAcceptNonCritical: on }
  await prisma.agentKvSetting.upsert({
    where: { key: OFFICE_SUPERVISOR_KV_KEY },
    create: { key: OFFICE_SUPERVISOR_KV_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  return next
}
