import { DAILY_DUTIES, JOB_TO_DUTY } from './duties.mjs'

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
  for (const d of DAILY_DUTIES) {
    const { data: existing } = await supabase
      .from('agent_duty_log')
      .select('duty')
      .eq('duty', d.duty)
      .eq('duty_date', dutyDate)
      .maybeSingle()
    if (existing) continue
    await supabase.from('agent_duty_log').insert({
      duty: d.duty,
      label: d.label,
      duty_date: dutyDate,
      status: 'pending',
      detail: null,
      ran_at: null,
    })
  }
}

export async function logDuty(supabase, jobName, status, detail) {
  const duty = JOB_TO_DUTY[jobName]
  if (!duty) return
  const dutyDate = dhakaDateYmd()
  const label = DAILY_DUTIES.find((d) => d.duty === duty)?.label ?? duty
  try {
    await supabase.from('agent_duty_log').upsert(
      {
        duty,
        label,
        duty_date: dutyDate,
        status,
        detail: detail ?? null,
        ran_at: new Date().toISOString(),
      },
      { onConflict: 'duty,duty_date' },
    )
  } catch (e) {
    console.warn('[duty-log]', e.message)
  }
}
