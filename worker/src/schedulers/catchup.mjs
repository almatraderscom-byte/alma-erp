import { DAILY_DUTIES, DUTY_CATCHUP } from './duties.mjs'
import { dhakaDateYmd } from './duty-log.mjs'
import { upsertDutyLog } from './duty-log-utils.mjs'

const JOB_FOR_DUTY = {
  owner_briefing: 'owner-briefing',
  daily_strategist: 'daily-strategist',
  cost_reconcile: 'cost-reconcile',
  daily_cashflow: 'daily-cashflow',
  morning_dispatch: 'morning-staff-reminder',
  ads_monitor: 'ads-monitor',
  ads_optimizer: 'ads-optimizer',
  token_health: 'token-health',
  content_engine_1: 'content-engine-1',
  subscription_renewal: 'subscription-renewal',
  approval_tracker: 'approval-tracker',
  staff_presence: 'staff-presence',
  outcome_measure: 'outcome-measure',
  payment_reminders: 'payment-reminders',
  order_watch: 'order-watch',
  staff_morale: 'staff-morale',
  midday_checkin: 'midday-checkin',
  personal_midday: 'personal-midday',
  content_engine_2: 'content-engine-2',
  content_engine_3: 'content-engine-3',
  owner_task_intake: 'owner-task-intake',
  night_report: 'night-report',
  personal_checkin: 'personal-checkin',
  evening_proposal: 'evening-proposal',
  approval_chase: 'approval-escalation',
  daily_summary: 'daily-summary',
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
  await upsertDutyLog(supabase, {
    duty,
    label: dutyLabel(duty),
    dutyDate: dhakaDateYmd(),
    status,
    detail: detail ?? null,
  })
}

async function alreadyNotifiedToday(supabase, today) {
  const key = `catchup_owner_notify:${today}`
  const { data } = await supabase.from('agent_kv_settings').select('value').eq('key', key).maybeSingle()
  return Boolean(data?.value)
}

async function markNotifiedToday(supabase, today, summary) {
  const key = `catchup_owner_notify:${today}`
  await supabase.from('agent_kv_settings').upsert(
    { key, value: JSON.stringify({ at: new Date().toISOString(), ...summary }) },
    { onConflict: 'key' },
  )
}

/**
 * Send ONE owner summary per day — never one message per recovered duty.
 */
async function sendCatchupSummary({ supabase, bot, ownerChatId, today, recovered, missed, missedCritical }) {
  if (!ownerChatId || !bot) return
  if (recovered.length === 0 && missed.length === 0) return
  if (await alreadyNotifiedToday(supabase, today)) {
    console.log('[catchup] owner summary skipped — already sent today')
    return
  }

  const lines = ['♻️ *Catch-up সম্পন্ন* (একটি সারাংশ — আলাদা restart মেসেজ নয়)']
  if (recovered.length) {
    lines.push('')
    lines.push(`✅ পুনরুদ্ধার (${recovered.length}টি):`)
    recovered.slice(0, 12).forEach((d, i) => lines.push(`${i + 1}. ${dutyLabel(d)}`))
    if (recovered.length > 12) lines.push(`…আরও ${recovered.length - 12}টি`)
  }
  if (missed.length) {
    lines.push('')
    lines.push(`🔴 মিস (${missed.length}টি):`)
    missed.slice(0, 8).forEach((d, i) => lines.push(`${i + 1}. ${dutyLabel(d)}`))
  }
  if (missedCritical.length) {
    lines.push('')
    lines.push('⚠️ জরুরি মিস — Monitor থেকে manually চালান।')
  }
  lines.push('')
  lines.push('Staff Monitor-এ duty count এখন আপডেট হবে।')

  await bot.telegram.sendMessage(ownerChatId, lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {
    return bot.telegram.sendMessage(ownerChatId, lines.join('\n').replace(/\*/g, ''))
  })
  await markNotifiedToday(supabase, today, { recovered: recovered.length, missed: missed.length })
  console.log(`[catchup] owner summary sent — recovered=${recovered.length} missed=${missed.length}`)
}

/**
 * Detect & recover missed critical duties for today.
 * @param {object} params
 * @param {import('@supabase/supabase-js').SupabaseClient} params.supabase
 * @param {import('telegraf').Telegraf} params.bot
 * @param {(jobName: string, opts?: { catchUp?: boolean }) => Promise<unknown>} params.runJob
 * @param {{ notifyOwner?: boolean, source?: 'startup' | 'scheduled' }} [params.opts]
 */
export async function runCatchup({ supabase, bot, runJob, opts = {} }) {
  const notifyOwner = opts.notifyOwner === true
  const source = opts.source ?? 'startup'

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
  const recovered = []
  const missed = []
  const missedCritical = []

  for (const [duty, policy] of Object.entries(DUTY_CATCHUP)) {
    const status = ran.get(duty)
    if (status === 'done' || status === 'skipped' || status === 'missed') continue

    if (nowMin < policy.scheduledAfterMin) continue

    if (nowMin > policy.catchUpUntilMin) {
      await upsertDutyStatus(supabase, duty, 'missed', 'worker down — window passed')
      missed.push(duty)
      if (policy.critical) missedCritical.push(duty)
      continue
    }

    const jobName = JOB_FOR_DUTY[duty]
    if (!jobName || typeof runJob !== 'function') continue

    try {
      console.log(`[catchup] (${source}) running late job ${jobName} for duty ${duty}`)
      await runJob(jobName, { catchUp: true })
      recovered.push(duty)
    } catch (e) {
      await upsertDutyStatus(supabase, duty, 'failed', `catch-up failed: ${e.message}`)
      console.error(`[catchup] ${duty} failed:`, e.message)
    }
  }

  if (recovered.length || missed.length) {
    console.log(`[catchup] (${source}) done — recovered=${recovered.length} missed=${missed.length}`)
  }

  // Startup catch-up after PM2 restart: never spam Telegram (216-restart loop caused floods).
  if (notifyOwner) {
    await sendCatchupSummary({ supabase, bot, ownerChatId, today, recovered, missed, missedCritical })
  }
}
