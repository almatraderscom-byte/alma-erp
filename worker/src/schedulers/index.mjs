/**
 * Scheduler Registry — Phase 6
 *
 * BullMQ repeatable jobs (Asia/Dhaka cron).
 * SINGLE SOURCE OF TRUTH: every job re-reads current state from DB before acting.
 * SCHEDULERS_ENABLED env flag is the global kill switch.
 *
 * Schedule (Asia/Dhaka = UTC+6):
 *   21:00  night-report        (daily — today's completion + carry-forward)
 *   21:05  evening-proposal    (daily — tomorrow's tasks, after night-report)
 *   09:00  morning-staff-reminder (daily — remind + track)
 *   09:30  ads-monitor         (daily)
 *   13:30  midday-checkin      (daily)
 *   Every 5 min: salah-escalation-check
 *   Every 15 min: messenger-scan
 *   21:30 Friday: weekly-review
 *   23:30  daily-summary       (daily)
 *
 * Crons are stored in agent_kv_settings and re-read each boot to allow live override.
 */

import { Queue, Worker } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { logDuty, seedDailyDuties, isTrackedDuty } from './duty-log.mjs'

// ── Lazy imports (only load when job runs) ─────────────────────────────────

const lazy = {
  eveningProposal:    () => import('../staff/evening-proposal.mjs'),
  morningStaffReminder: () => import('../staff/morning-staff-reminder.mjs'),
  middayCheckin:      () => import('../staff/midday-checkin.mjs'),
  nightReport:        () => import('../staff/night-report.mjs'),
  weeklyReview:       () => import('../staff/weekly-review.mjs'),
  messengerScan:      () => import('../messenger/scan.mjs'),
  adsMonitor:         () => import('../ads/monitor.mjs'),
  salahScheduler:     () => import('../salah/scheduler.mjs'),
  dailySummary:       () => import('./daily-summary.mjs'),
  subscriptionRenewal: () => import('./subscription-renewal.mjs'),
  budgetCheck:        () => import('./budget-check.mjs'),
  balanceCheck:       () => import('./balance-check.mjs'),
  proofTimeout:       () => import('../staff/proof-timeout.mjs'),
  costReconcile:      () => import('./cost-reconcile.mjs'),
  reminderTicker:     () => import('../reminders/ticker.mjs'),
  csIndexProducts:    () => import('../cs/index-products.mjs'),
  csEscalation:       () => import('../cs/escalation.mjs'),
  csFollowups:        () => import('../cs/followups.mjs'),
  csMessengerPoll:    () => import('../cs/messenger-poll.mjs'),
  tokenHealth:        () => import('../cs/token-health.mjs'),
  sessionSummarizer:  () => import('../memory/session-summarizer.mjs'),
  ownerBriefing:      () => import('../reports/owner-briefing-run.mjs'),
  customerIntel:      () => import('../reports/customer-intel.mjs'),
  approvalEscalation: () => import('../staff/approval-escalation.mjs'),
  staffPresence:      () => import('../staff/presence-nudge.mjs'),
  approvalTracker:    () => import('../approvals/tracker.mjs'),
  orderWatch:         () => import('../orders/watch.mjs'),
  ackEscalation:      () => import('../staff/ack-escalation.mjs'),
  personalCheckin:    () => import('../personal/checkin.mjs'),
  lunchWatch:         () => import('../staff/lunch-watch.mjs'),
  staffMorale:        () => import('../staff/morale.mjs'),
  contentEngine:      () => import('../content-engine/run.mjs'),
  weeklyReflection:   () => import('../intelligence/reflection.mjs'),
  dailyStrategist:    () => import('../intelligence/strategist.mjs'),
}

// ── Registry table ────────────────────────────────────────────────────────────
// This is the authoritative list of every repeatable job.

export const SCHEDULER_REGISTRY = [
  { name: 'salah-init',             cronUtc: '0 18 * * *',   description: 'Midnight Dhaka — create today salah records' },
  { name: 'night-report',           cronUtc: '0 15 * * *',   description: 'Night staff report (21:00 Dhaka)' },
  { name: 'approval-escalation',  cronUtc: '30 16,17 * * *', description: 'Chase unapproved task proposal (22:30/23:30 Dhaka)' },
  { name: 'approval-tracker',     cronUtc: '0 4,8,13 * * *', description: 'Re-surface unresolved approvals (10:00, 14:00, 19:00 Dhaka)' },
  { name: 'catchup-scan',         cronUtc: '0 4 * * *',    description: 'Catch-up missed duties (10:00 Dhaka)' },
  { name: 'evening-proposal',       cronUtc: '5 15 * * *',  description: 'Evening task proposal for tomorrow (21:05 Dhaka)' },
  { name: 'owner-briefing',         cronUtc: '30 1 * * *',   description: 'Owner morning briefing (07:30 Dhaka)' },
  { name: 'daily-strategist',       cronUtc: '0 2 * * *',    description: 'Daily cross-domain strategy pass (08:00 Dhaka)' },
  { name: 'order-watch',            cronUtc: '0 6,12 * * *', description: 'Order issue scan (12:00, 18:00 Dhaka)' },
  { name: 'content-engine-3',       cronUtc: '0 13 * * *',  description: 'Auto post prep #3 (19:00 Dhaka)' },
  { name: 'morning-staff-reminder', cronUtc: '0 3 * * *',   description: 'Morning staff remind + dispatch (09:00 Dhaka)' },
  { name: 'content-engine-1',       cronUtc: '0 4 * * *',   description: 'Auto post prep #1 (10:00 Dhaka)' },
  { name: 'ads-monitor',            cronUtc: '30 3 * * *',   description: 'Ads daily digest (09:30 Dhaka)' },
  { name: 'midday-checkin',         cronUtc: '30 7 * * *',   description: 'Staff midday reminder (13:30 Dhaka)' },
  { name: 'content-engine-2',       cronUtc: '0 9 * * *',   description: 'Auto post prep #2 (15:00 Dhaka)' },
  { name: 'staff-morale',           cronUtc: '0 7 * * *',    description: 'Daily staff encouragement (13:00 Dhaka)' },
  { name: 'staff-presence',         cronUtc: '0 5,11 * * *', description: 'Staff presence nudges (11:00, 17:00 Dhaka)' },
  { name: 'salah-escalation',       cronUtc: '*/5 * * * *',  description: 'Salah escalation check (every 5 min)' },
  { name: 'messenger-scan',         cronUtc: '*/15 * * * *', description: 'Messenger unanswered scan (every 15 min)' },
  { name: 'session-summarizer',     cronUtc: '*/15 * * * *', description: 'Summarize ended owner chats into memory (every 15 min)' },
  { name: 'weekly-review',          cronUtc: '30 15 * * 5',  description: 'Friday weekly review (21:30 Dhaka)' },
  { name: 'weekly-reflection',      cronUtc: '0 16 * * 5',   description: 'Weekly self-reflection → playbook proposals (22:00 Fri Dhaka)' },
  { name: 'daily-summary',          cronUtc: '30 17 * * *',  description: 'Daily summary + salah scorecard (23:30 Dhaka)' },
  { name: 'customer-intel',         cronUtc: '0 4 * * 6',    description: 'Weekly customer win-back + loyalty digest (Sat 10:00 Dhaka)' },
  { name: 'subscription-renewal',   cronUtc: '0 4 * * *',    description: 'Subscription renewal alerts (10:00 Dhaka)' },
  { name: 'budget-check',           cronUtc: '0 * * * *',    description: 'Hourly AI budget threshold check' },
  { name: 'balance-check',          cronUtc: '0 */6 * * *',  description: 'API provider balance refresh (every 6h)' },
  { name: 'proof-timeout',          cronUtc: '*/5 * * * *',    description: 'Task proof reminder + 2h unverified flag' },
  { name: 'ack-escalation',         cronUtc: '*/5 * * * *',    description: 'Escalate unseen staff messages (every 5 min)' },
  { name: 'lunch-watch',            cronUtc: '*/5 * * * *',    description: 'Check overdue staff lunches (every 5 min)' },
  { name: 'personal-checkin',       cronUtc: '0 15 * * *',     description: 'Evening personal/family check-in (21:00 Dhaka)' },
  { name: 'personal-midday',        cronUtc: '0 8 * * *',      description: 'Brief daytime personal check-in (14:00 Dhaka)' },
  { name: 'cost-reconcile',         cronUtc: '15 2 * * *',   description: 'Nightly cost reconciliation (08:15 Dhaka)' },
  { name: 'reminder-ticker',        cronUtc: '* * * * *',    description: 'Personal reminder ticker (every minute)' },
  { name: 'cs-index-products',      cronUtc: '30 18 * * *',  description: 'Nightly product visual index (00:30 Dhaka)' },
  { name: 'cs-escalation',          cronUtc: '* * * * *',    description: 'CS shadow draft escalation (every minute)' },
  { name: 'cs-followups',           cronUtc: '*/15 * * * *', description: 'CS follow-up recovery (every 15 min)' },
  { name: 'cs-messenger-poll',      cronUtc: '*/2 * * * *',  description: 'CS inbox poll fallback (every 2 min)' },
  { name: 'token-health',           cronUtc: '30 3 * * *',   description: 'Daily Meta page token health check (09:30 Dhaka)' },
  { name: 'outcome-measure',        cronUtc: '0 5 * * *',    description: 'Measure matured agent suggestions (11:00 Dhaka)' },
  { name: 'knowledge-build',        cronUtc: '0 19 * * *',   description: 'Nightly business knowledge graph build (01:00 Dhaka)' },
]

// ── Shared job runner (cron worker + catch-up) ───────────────────────────────

/**
 * @param {string} jobName
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient, bot: import('telegraf').Telegraf }} context
 * @param {{ catchUp?: boolean }} [opts]
 */
export async function runSchedulerJob(jobName, context, opts = {}) {
  const { supabase, bot } = context
  let dutyResult = null

  switch (jobName) {
    case 'salah-init': {
      const { initializeDailySalahRecords } = await lazy.salahScheduler()
      await initializeDailySalahRecords(supabase)
      await seedDailyDuties(supabase)
      dutyResult = { dutyStatus: 'done' }
      break
    }
    case 'approval-escalation': {
      const { runApprovalEscalation } = await lazy.approvalEscalation()
      await runApprovalEscalation({ supabase, bot })
      break
    }
    case 'approval-tracker': {
      const { runApprovalTracker } = await lazy.approvalTracker()
      await runApprovalTracker({ supabase, bot })
      break
    }
    case 'catchup-scan': {
      const { runCatchup } = await import('./catchup.mjs')
      await runCatchup({
        supabase,
        bot,
        runJob: (name, catchOpts) => runSchedulerJob(name, context, catchOpts ?? {}),
      })
      break
    }
    case 'evening-proposal': {
      const { runEveningProposal } = await lazy.eveningProposal()
      dutyResult = await runEveningProposal(supabase)
      break
    }
    case 'owner-briefing': {
      const { runOwnerBriefing } = await lazy.ownerBriefing()
      await runOwnerBriefing({ supabase, bot })
      dutyResult = { dutyStatus: 'done' }
      break
    }
    case 'order-watch': {
      const { runOrderWatch } = await lazy.orderWatch()
      await runOrderWatch({ bot })
      dutyResult = { dutyStatus: 'done' }
      break
    }
    case 'morning-staff-reminder': {
      const { runMorningStaffReminder } = await lazy.morningStaffReminder()
      dutyResult = await runMorningStaffReminder(context)
      break
    }
    case 'content-engine-1':
    case 'content-engine-2':
    case 'content-engine-3': {
      const { runContentEngineSlot } = await lazy.contentEngine()
      const slot = Number(jobName.split('-').pop())
      dutyResult = await runContentEngineSlot({ supabase, slot })
      break
    }
    case 'ads-monitor': {
      const { runAdsMonitor } = await lazy.adsMonitor()
      await runAdsMonitor({ supabase })
      break
    }
    case 'midday-checkin': {
      const { runMiddayCheckin } = await lazy.middayCheckin()
      await runMiddayCheckin(context)
      dutyResult = { dutyStatus: 'done' }
      break
    }
    case 'staff-morale': {
      const { runStaffMorale } = await lazy.staffMorale()
      dutyResult = await runStaffMorale(context)
      break
    }
    case 'staff-presence': {
      const { runStaffPresence } = await lazy.staffPresence()
      await runStaffPresence(context)
      break
    }
    case 'salah-escalation': {
      const { checkAndEscalateSalah } = await lazy.salahScheduler()
      await checkAndEscalateSalah(context)
      break
    }
    case 'messenger-scan': {
      const { runMessengerScan } = await lazy.messengerScan()
      await runMessengerScan(context)
      dutyResult = { dutyStatus: 'done' }
      break
    }
    case 'session-summarizer': {
      const { runSessionSummarizer } = await lazy.sessionSummarizer()
      await runSessionSummarizer()
      break
    }
    case 'night-report': {
      const { runNightReport } = await lazy.nightReport()
      await runNightReport(context)
      dutyResult = { dutyStatus: 'done' }
      break
    }
    case 'weekly-review': {
      const { runWeeklyReview } = await lazy.weeklyReview()
      await runWeeklyReview({ supabase, bot })
      break
    }
    case 'daily-summary': {
      const { runDailySummary } = await lazy.dailySummary()
      await runDailySummary(context)
      break
    }
    case 'customer-intel': {
      const { runCustomerIntel } = await lazy.customerIntel()
      await runCustomerIntel({ bot })
      break
    }
    case 'subscription-renewal': {
      const { runSubscriptionRenewalCheck } = await lazy.subscriptionRenewal()
      await runSubscriptionRenewalCheck(context)
      break
    }
    case 'budget-check': {
      const { runBudgetCheck } = await lazy.budgetCheck()
      await runBudgetCheck()
      break
    }
    case 'balance-check': {
      const { runBalanceCheck } = await lazy.balanceCheck()
      await runBalanceCheck()
      break
    }
    case 'proof-timeout': {
      const { runProofTimeoutCheck } = await lazy.proofTimeout()
      await runProofTimeoutCheck(context)
      break
    }
    case 'ack-escalation': {
      const { runAckEscalation } = await lazy.ackEscalation()
      await runAckEscalation(context)
      break
    }
    case 'lunch-watch': {
      const { runLunchWatch } = await lazy.lunchWatch()
      await runLunchWatch(context)
      break
    }
    case 'personal-checkin': {
      const { runPersonalCheckin } = await lazy.personalCheckin()
      dutyResult = await runPersonalCheckin(context)
      break
    }
    case 'personal-midday': {
      const { runPersonalMidday } = await lazy.personalCheckin()
      dutyResult = await runPersonalMidday(context)
      break
    }
    case 'cost-reconcile': {
      const { runCostReconciliation } = await lazy.costReconcile()
      await runCostReconciliation()
      break
    }
    case 'reminder-ticker': {
      const { runReminderTicker } = await lazy.reminderTicker()
      await runReminderTicker(context)
      break
    }
    case 'cs-index-products': {
      const { runCsIndexProducts } = await lazy.csIndexProducts()
      await runCsIndexProducts()
      break
    }
    case 'cs-escalation': {
      const { runCsEscalation } = await lazy.csEscalation()
      await runCsEscalation(bot)
      break
    }
    case 'cs-followups': {
      const { runCsFollowups } = await lazy.csFollowups()
      await runCsFollowups()
      break
    }
    case 'cs-messenger-poll': {
      const { pollMessengerInbox } = await lazy.csMessengerPoll()
      await pollMessengerInbox()
      break
    }
    case 'token-health': {
      const { checkPageTokenHealth } = await lazy.tokenHealth()
      await checkPageTokenHealth()
      break
    }
    case 'outcome-measure': {
      const { runOutcomeMeasure } = await import('../intelligence/outcome-measure.mjs')
      await runOutcomeMeasure()
      break
    }
    case 'knowledge-build': {
      const { runKnowledgeBuild } = await import('../intelligence/knowledge-build.mjs')
      await runKnowledgeBuild()
      break
    }
    case 'weekly-reflection': {
      const { runWeeklyReflection } = await lazy.weeklyReflection()
      await runWeeklyReflection()
      break
    }
    case 'daily-strategist': {
      const { runDailyStrategist } = await lazy.dailyStrategist()
      await runDailyStrategist()
      break
    }
    default:
      console.warn(`[schedulers] unknown job: ${jobName}`)
  }

  if (isTrackedDuty(jobName)) {
    const detail = opts.catchUp
      ? `(catch-up — worker had been down)${dutyResult?.dutyDetail ? ` — ${dutyResult.dutyDetail}` : ''}`
      : (dutyResult?.dutyDetail ?? null)
    await logDuty(supabase, jobName, dutyResult?.dutyStatus ?? 'done', detail)
  }

  return dutyResult
}

// ── Setup function (called from worker/src/index.mjs) ─────────────────────────

export async function setupSchedulers({ connection, supabase, bot }) {
  if (process.env.SCHEDULERS_ENABLED !== 'true') {
    console.log('[schedulers] SCHEDULERS_ENABLED != true — all scheduled jobs disabled')
    return null
  }

  const context = { supabase, bot }

  const schedulerQueue = new Queue('schedulers', {
    connection,
    defaultJobOptions: {
      removeOnComplete: { count: 10 },
      removeOnFail:     { count: 20 },
    },
  })

  // Remove all existing repeatable jobs (re-register on each boot to pick up cron overrides)
  const existing = await schedulerQueue.getRepeatableJobs()
  for (const job of existing) {
    await schedulerQueue.removeRepeatableByKey(job.key)
  }

  // Register each job from the registry
  for (const entry of SCHEDULER_REGISTRY) {
    await schedulerQueue.add(
      entry.name,
      { jobName: entry.name },
      { repeat: { pattern: entry.cronUtc, tz: 'UTC' } },
    )
    console.log(`[schedulers] registered ${entry.name} — ${entry.cronUtc} UTC`)
  }

  // Worker that dispatches to the correct handler
  const schedulerWorker = new Worker('schedulers', async (job) => {
    if (process.env.SCHEDULERS_ENABLED !== 'true') {
      console.log(`[schedulers] ${job.name} skipped — SCHEDULERS_ENABLED=false`)
      return
    }

    const started = Date.now()
    console.log(`[schedulers] ▶ ${job.name} starting...`)

    try {
      await runSchedulerJob(job.name, context)
      const elapsed = ((Date.now() - started) / 1000).toFixed(1)
      console.log(`[schedulers] ✓ ${job.name} done (${elapsed}s)`)
    } catch (err) {
      if (isTrackedDuty(job.name)) {
        await logDuty(supabase, job.name, 'failed', err.message)
      }
      const elapsed = ((Date.now() - started) / 1000).toFixed(1)
      console.error(`[schedulers] ✗ ${job.name} FAILED (${elapsed}s):`, err.message, err.stack)
      throw err
    }
  }, {
    connection,
    concurrency: 2,
  })

  schedulerWorker.on('failed', (job, err) => {
    console.error(`[schedulers] ${job?.name} failed:`, err.message)
  })

  console.log(`[schedulers] ${SCHEDULER_REGISTRY.length} jobs registered`)

  // Ensure today's duty roster exists (idempotent — mid-day deploys still show pending duties)
  try {
    await seedDailyDuties(supabase)
  } catch (e) {
    console.warn('[schedulers] seedDailyDuties failed:', e.message)
  }

  return {
    schedulerQueue,
    runSchedulerJob: (jobName, opts) => runSchedulerJob(jobName, context, opts),
  }
}
