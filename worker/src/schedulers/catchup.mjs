import { DAILY_DUTIES, DUTY_CATCHUP } from './duties.mjs'
import { dhakaDateYmd } from './duty-log.mjs'

const JOB_FOR_DUTY = {
  morning_dispatch: 'morning-staff-reminder',
  owner_briefing: 'owner-briefing',
  evening_proposal: 'evening-proposal',
  night_report: 'night-report',
  order_watch: 'order-watch',
}

function nowMinDhaka() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  return Number(p.find((x) => x.type === 'hour')?.value ?? 0) * 60
    + Number(p.find((x) => x.type === 'minute')?.value ?? 0)
}

function dutyLabel(duty) {
  return DAILY_DUTIES.find((d) => d.duty === duty)?.label ?? duty
}

async function upsertDutyStatus(supabase, duty, status, detail) {
  const dutyDate = dhakaDateYmd()
  await supabase.from('agent_duty_log').upsert(
    {
      duty,
      label: dutyLabel(duty),
      duty_date: dutyDate,
      status,
      detail: detail ?? null,
      ran_at: new Date().toISOString(),
    },
    { onConflict: 'duty,duty_date' },
  )
}

/**
 * Detect & recover missed critical duties for today.
 * @param {object} params
 * @param {import('@supabase/supabase-js').SupabaseClient} params.supabase
 * @param {import('telegraf').Telegraf} params.bot
 * @param {(jobName: string, opts?: { catchUp?: boolean }) => Promise<unknown>} params.runJob
 */
export async function runCatchup({ supabase, bot, runJob }) {
  if (process.env.SCHEDULERS_ENABLED !== 'true') {
    console.log('[catchup] skipped — SCHEDULERS_ENABLED=false')
    return
  }

  const today = dhakaDateYmd()
  const nowMin = nowMinDhaka()
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID

  const { data: logs } = await supabase
    .from('agent_duty_log')
    .select('duty, status')
    .eq('duty_date', today)

  const ran = new Map((logs ?? []).map((l) => [l.duty, l.status]))
  let recovered = 0
  let missed = 0

  for (const [duty, policy] of Object.entries(DUTY_CATCHUP)) {
    const status = ran.get(duty)
    if (status === 'done' || status === 'skipped' || status === 'missed') continue

    if (nowMin < policy.scheduledAfterMin) continue

    if (nowMin > policy.catchUpUntilMin) {
      await upsertDutyStatus(supabase, duty, 'missed', 'worker down — window passed')
      missed++
      if (policy.critical && ownerChatId && bot) {
        await bot.telegram.sendMessage(
          ownerChatId,
          `🔴 আজকের একটি জরুরি কাজ মিস হয়েছে: ${dutyLabel(duty)}। worker সম্ভবত বন্ধ ছিল। দয়া করে manually চালান বা চেক করুন।`,
        ).catch(() => {})
      }
      continue
    }

    const jobName = JOB_FOR_DUTY[duty]
    if (!jobName || typeof runJob !== 'function') continue

    try {
      console.log(`[catchup] running late job ${jobName} for duty ${duty}`)
      await runJob(jobName, { catchUp: true })
      recovered++
      if (ownerChatId && bot) {
        await bot.telegram.sendMessage(
          ownerChatId,
          `♻️ worker পুনরায় চালু — মিস হওয়া কাজ catch-up করা হলো: ${dutyLabel(duty)}।`,
        ).catch(() => {})
      }
    } catch (e) {
      await upsertDutyStatus(supabase, duty, 'failed', `catch-up failed: ${e.message}`)
      console.error(`[catchup] ${duty} failed:`, e.message)
    }
  }

  if (recovered || missed) {
    console.log(`[catchup] done — recovered=${recovered} missed=${missed}`)
  }
}
