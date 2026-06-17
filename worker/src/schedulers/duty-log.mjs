import { DAILY_DUTIES, JOB_TO_DUTY, dutiesForToday } from './duties.mjs'
import { insertPendingDutyLog, upsertDutyLog } from './duty-log-utils.mjs'

export function dhakaDateYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

export function isTrackedDuty(jobName) {
  return Boolean(JOB_TO_DUTY[jobName])
}

/**
 * Pre-seed today's expected duties as pending (idempotent — never overwrites done/failed/skipped).
 */
export async function seedDailyDuties(supabase) {
  const dutyDate = dhakaDateYmd()
  const { isDutyEnabled } = await import('./duty-enabled.mjs')
  for (const d of dutiesForToday()) {
    if (!(await isDutyEnabled(supabase, d.duty))) continue
    await insertPendingDutyLog(supabase, {
      duty: d.duty,
      label: d.label,
      dutyDate,
    })
  }
}

export async function logDuty(supabase, jobName, status, detail) {
  const duty = JOB_TO_DUTY[jobName]
  if (!duty) return
  const dutyDate = dhakaDateYmd()
  const label = DAILY_DUTIES.find((d) => d.duty === duty)?.label ?? duty
  await upsertDutyLog(supabase, {
    duty,
    label,
    dutyDate,
    status,
    detail: detail ?? null,
  })
}
