#!/usr/bin/env node
/**
 * Manual job trigger for testing schedulers.
 * Usage: node worker/scripts/trigger.mjs <job-name>
 * Examples:
 *   node worker/scripts/trigger.mjs evening-proposal
 *   node worker/scripts/trigger.mjs morning-staff-reminder
 *   node worker/scripts/trigger.mjs night-report
 *   node worker/scripts/trigger.mjs salah-escalation
 *   node worker/scripts/trigger.mjs messenger-scan
 *   node worker/scripts/trigger.mjs daily-summary
 *   node worker/scripts/trigger.mjs weekly-review
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const jobName = process.argv[2]
if (!jobName) {
  console.error('Usage: node trigger.mjs <job-name>')
  console.error('Jobs: salah-init, evening-proposal, morning-staff-reminder, ads-monitor, midday-checkin, salah-escalation,')
  console.error('      messenger-scan, night-report, weekly-review, daily-summary, reminder-ticker')
  process.exit(1)
}

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Minimal mock bot (Telegram API calls work if ASSISTANT_BOT_TOKEN is set)
let bot = null
try {
  if (process.env.ASSISTANT_BOT_TOKEN) {
    const { Telegraf } = await import('telegraf')
    bot = new Telegraf(process.env.ASSISTANT_BOT_TOKEN)
    console.log('[trigger] Telegram bot initialized')
  }
} catch (err) {
  console.warn('[trigger] Telegram not available:', err.message)
}

// Set up notify module
try {
  const { setTelegramForNotify } = await import('../src/notify/index.mjs')
  if (bot && process.env.TELEGRAM_OWNER_CHAT_ID) {
    setTelegramForNotify(bot, process.env.TELEGRAM_OWNER_CHAT_ID)
  }
} catch {}

const context = { supabase, bot }

console.log(`[trigger] Running job: ${jobName}`)

const handlers = {
  'evening-proposal':       async () => { const { runEveningProposal } = await import('../src/staff/evening-proposal.mjs'); await runEveningProposal(supabase) },
  'morning-staff-reminder': async () => { const { runMorningStaffReminder } = await import('../src/staff/morning-staff-reminder.mjs'); await runMorningStaffReminder(context) },
  'morning-proposal':       async () => { const { runTaskProposal } = await import('../src/staff/morning-proposal.mjs'); await runTaskProposal(supabase, { targetOffsetDays: 1 }) },
  'ads-monitor':       async () => { const { runAdsMonitor } = await import('../src/ads/monitor.mjs'); await runAdsMonitor({ supabase }) },
  'midday-checkin':    async () => { const { runMiddayCheckin } = await import('../src/staff/midday-checkin.mjs'); await runMiddayCheckin(context) },
  'salah-escalation':  async () => { const { checkAndEscalateSalah } = await import('../src/salah/scheduler.mjs'); await checkAndEscalateSalah(context) },
  'messenger-scan':    async () => { const { runMessengerScan } = await import('../src/messenger/scan.mjs'); await runMessengerScan(context) },
  'night-report':      async () => { const { runNightReport } = await import('../src/staff/night-report.mjs'); await runNightReport(context) },
  'weekly-review':     async () => { const { runWeeklyReview } = await import('../src/staff/weekly-review.mjs'); await runWeeklyReview({ supabase }) },
  'daily-summary':     async () => { const { runDailySummary } = await import('../src/schedulers/daily-summary.mjs'); await runDailySummary(context) },
  'salah-init':        async () => { const { initializeDailySalahRecords } = await import('../src/salah/scheduler.mjs'); await initializeDailySalahRecords(supabase) },
  'reminder-ticker':   async () => { const { runReminderTicker } = await import('../src/reminders/ticker.mjs'); await runReminderTicker(context) },
}

const handler = handlers[jobName]
if (!handler) {
  console.error(`Unknown job: ${jobName}`)
  console.error('Available:', Object.keys(handlers).join(', '))
  process.exit(1)
}

try {
  await handler()
  console.log(`[trigger] ✅ ${jobName} completed`)
} catch (err) {
  console.error(`[trigger] ❌ ${jobName} failed:`, err.message, err.stack)
  process.exit(1)
}
