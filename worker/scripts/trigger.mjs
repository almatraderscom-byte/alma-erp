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
  console.error('      messenger-scan, night-report, weekly-review, daily-summary, reminder-ticker, import-size-charts,')
  console.error('      cs-index-products, cs-escalation')
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

// Set up notify + dispatcher modules
try {
  const { setTelegramForNotify } = await import('../src/notify/index.mjs')
  if (bot && process.env.TELEGRAM_OWNER_CHAT_ID) {
    setTelegramForNotify(bot, process.env.TELEGRAM_OWNER_CHAT_ID)
  }
} catch {}
try {
  const { setDispatcherBot } = await import('../src/telegram/dispatcher.mjs')
  if (bot && process.env.TELEGRAM_OWNER_CHAT_ID) {
    setDispatcherBot(bot, process.env.TELEGRAM_OWNER_CHAT_ID)
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
  'cs-index-products': async () => {
    const { runCsIndexProducts } = await import('../src/cs/index-products.mjs')
    await runCsIndexProducts()
  },
  'token-health': async () => {
    const { checkPageTokenHealth } = await import('../src/cs/token-health.mjs')
    await checkPageTokenHealth()
  },
  'cs-escalation': async () => {
    const { runCsEscalation } = await import('../src/cs/escalation.mjs')
    await runCsEscalation(bot)
  },
  'full-day-simulation': async () => {
    console.log('[simulation] === Full Day Chain Simulation ===')
    console.log('[simulation] Step 1: evening-proposal (propose tomorrow\'s tasks)')
    const { runEveningProposal } = await import('../src/staff/evening-proposal.mjs')
    await runEveningProposal(supabase)
    console.log('[simulation] ✅ evening-proposal done')

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })

    const { data: proposed } = await supabase
      .from('staff_tasks')
      .select('id')
      .eq('proposed_for', tomorrowStr)
      .eq('status', 'proposed')
    console.log(`[simulation] ${proposed?.length ?? 0} tasks proposed for ${tomorrowStr}`)

    if (proposed?.length) {
      console.log('[simulation] Step 2: auto-approving proposed tasks for simulation')
      await supabase
        .from('staff_tasks')
        .update({ status: 'approved' })
        .eq('proposed_for', tomorrowStr)
        .eq('status', 'proposed')
    }

    console.log('[simulation] Step 3: morning-staff-reminder (dispatch)')
    const { runMorningStaffReminder } = await import('../src/staff/morning-staff-reminder.mjs')
    await runMorningStaffReminder({ supabase, bot })
    console.log('[simulation] ✅ morning-staff-reminder done')

    console.log('[simulation] Step 4: midday-checkin')
    const { runMiddayCheckin } = await import('../src/staff/midday-checkin.mjs')
    await runMiddayCheckin({ supabase, bot })
    console.log('[simulation] ✅ midday-checkin done')

    console.log('[simulation] Step 5: night-report')
    const { runNightReport } = await import('../src/staff/night-report.mjs')
    await runNightReport({ supabase, bot })
    console.log('[simulation] ✅ night-report done')

    console.log('[simulation] === Simulation Complete ===')
  },
  'import-size-charts': async () => {
    const APP_URL = process.env.APP_URL?.replace(/\/$/, '')
    const TOKEN = process.env.AGENT_INTERNAL_TOKEN
    const res = await fetch(`${APP_URL}/api/assistant/internal/catalog/import-size-charts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ useSeedFile: true }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
    console.log(`[trigger] imported ${data.inserted} size chart rows`)
  },
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
