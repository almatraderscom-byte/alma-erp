/**
 * Scheduler Registry — Phase 6
 *
 * BullMQ repeatable jobs (Asia/Dhaka cron).
 * SINGLE SOURCE OF TRUTH: every job re-reads current state from DB before acting.
 * SCHEDULERS_ENABLED env flag is the global kill switch.
 *
 * Schedule (Asia/Dhaka = UTC+6):
 *   20:00  evening-proposal    (daily — tomorrow's tasks)
 *   09:00  morning-staff-reminder (daily — remind + track)
 *   09:30  ads-monitor         (daily)
 *   13:30  midday-checkin      (daily)
 *   Every 5 min: salah-escalation-check
 *   Every 15 min: messenger-scan
 *   21:00  night-report        (daily)
 *   21:30 Friday: weekly-review
 *   23:30  daily-summary       (daily)
 *
 * Crons are stored in agent_kv_settings and re-read each boot to allow live override.
 */

import { Queue, Worker } from 'bullmq'
import { createClient } from '@supabase/supabase-js'

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
  costReconcile:      () => import('./cost-reconcile.mjs'),
  reminderTicker:     () => import('../reminders/ticker.mjs'),
  csIndexProducts:    () => import('../cs/index-products.mjs'),
  csEscalation:       () => import('../cs/escalation.mjs'),
  csFollowups:        () => import('../cs/followups.mjs'),
}

// ── Registry table ────────────────────────────────────────────────────────────
// This is the authoritative list of every repeatable job.

export const SCHEDULER_REGISTRY = [
  { name: 'salah-init',             cronUtc: '0 18 * * *',   description: 'Midnight Dhaka — create today salah records' },
  { name: 'evening-proposal',       cronUtc: '0 14 * * *',  description: 'Evening task proposal for tomorrow (20:00 Dhaka)' },
  { name: 'morning-staff-reminder', cronUtc: '0 3 * * *',   description: 'Morning staff remind + dispatch (09:00 Dhaka)' },
  { name: 'ads-monitor',            cronUtc: '30 3 * * *',   description: 'Ads daily digest (09:30 Dhaka)' },
  { name: 'midday-checkin',         cronUtc: '30 7 * * *',   description: 'Staff midday reminder (13:30 Dhaka)' },
  { name: 'salah-escalation',       cronUtc: '*/5 * * * *',  description: 'Salah escalation check (every 5 min)' },
  { name: 'messenger-scan',         cronUtc: '*/15 * * * *', description: 'Messenger unanswered scan (every 15 min)' },
  { name: 'night-report',           cronUtc: '0 15 * * *',   description: 'Night staff report (21:00 Dhaka)' },
  { name: 'weekly-review',          cronUtc: '30 15 * * 5',  description: 'Friday weekly review (21:30 Dhaka)' },
  { name: 'daily-summary',          cronUtc: '30 17 * * *',  description: 'Daily summary + salah scorecard (23:30 Dhaka)' },
  { name: 'subscription-renewal',   cronUtc: '0 4 * * *',    description: 'Subscription renewal alerts (10:00 Dhaka)' },
  { name: 'budget-check',           cronUtc: '0 * * * *',    description: 'Hourly AI budget threshold check' },
  { name: 'cost-reconcile',         cronUtc: '15 2 * * *',   description: 'Nightly cost reconciliation (08:15 Dhaka)' },
  { name: 'reminder-ticker',        cronUtc: '* * * * *',    description: 'Personal reminder ticker (every minute)' },
  { name: 'cs-index-products',      cronUtc: '30 18 * * *',  description: 'Nightly product visual index (00:30 Dhaka)' },
  { name: 'cs-escalation',          cronUtc: '* * * * *',    description: 'CS shadow draft escalation (every minute)' },
  { name: 'cs-followups',           cronUtc: '*/15 * * * *', description: 'CS follow-up recovery (every 15 min)' },
]

// ── Setup function (called from worker/src/index.mjs) ─────────────────────────

export async function setupSchedulers({ connection, supabase, bot }) {
  if (process.env.SCHEDULERS_ENABLED !== 'true') {
    console.log('[schedulers] SCHEDULERS_ENABLED != true — all scheduled jobs disabled')
    return null
  }

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

    console.log(`[schedulers] running ${job.name}...`)

    const context = { supabase, bot }

    try {
      switch (job.name) {
        case 'salah-init': {
          const { initializeDailySalahRecords } = await lazy.salahScheduler()
          await initializeDailySalahRecords(supabase)
          break
        }
        case 'evening-proposal': {
          const { runEveningProposal } = await lazy.eveningProposal()
          await runEveningProposal(supabase)
          break
        }
        case 'morning-staff-reminder': {
          const { runMorningStaffReminder } = await lazy.morningStaffReminder()
          await runMorningStaffReminder({ supabase, bot })
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
          break
        }
        case 'night-report': {
          const { runNightReport } = await lazy.nightReport()
          await runNightReport(context)
          break
        }
        case 'weekly-review': {
          const { runWeeklyReview } = await lazy.weeklyReview()
          await runWeeklyReview({ supabase })
          break
        }
        case 'daily-summary': {
          const { runDailySummary } = await lazy.dailySummary()
          await runDailySummary(context)
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
        default:
          console.warn(`[schedulers] unknown job: ${job.name}`)
      }

      console.log(`[schedulers] ${job.name} done`)
    } catch (err) {
      console.error(`[schedulers] ${job.name} FAILED:`, err.message, err.stack)
      throw err  // BullMQ will retry based on job options
    }
  }, {
    connection,
    concurrency: 2,
  })

  schedulerWorker.on('failed', (job, err) => {
    console.error(`[schedulers] ${job?.name} failed:`, err.message)
  })

  console.log(`[schedulers] ${SCHEDULER_REGISTRY.length} jobs registered`)
  return schedulerQueue
}
