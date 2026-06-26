/**
 * Owner-tunable office-supervisor behaviour (KV-backed, no redeploy).
 *
 * KV key `office_supervisor`: JSON `{ "autoAcceptNonCritical"?: boolean }`.
 *
 * `autoAcceptNonCritical` — when the supervisor exhausts its redo/clarify
 * attempts (MAX_AUTO_REDO / MAX_CLARIFY) and STILL can't verify or understand a
 * task:
 *   - false (DEFAULT): escalate the task to the owner for approval — even
 *     low-stakes ones. This matches the owner's rule "1-2 চেষ্টায় না পারলে
 *     আমার কাছে পাঠাবে; আমি approve করলেই Accepted".
 *   - true: the old 90/10 behaviour — silently accept low-stakes unverifiable
 *     tasks as done, only escalate the critical (money/customer) ~10%. Use this
 *     if owner escalations become too noisy.
 */
import { prisma } from '@/lib/prisma'

export const OFFICE_SUPERVISOR_KV_KEY = 'office_supervisor'

export type OfficeSupervisorSettings = {
  autoAcceptNonCritical: boolean
}

const DEFAULTS: OfficeSupervisorSettings = {
  autoAcceptNonCritical: false,
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
