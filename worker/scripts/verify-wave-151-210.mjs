#!/usr/bin/env node
/**
 * Smoke test — wave 151-210 structural checks.
 * Run: node worker/scripts/verify-wave-151-210.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../..')

let passed = 0
let failed = 0

function assertFile(rel, predicate, label) {
  const p = path.join(root, rel)
  if (!fs.existsSync(p)) {
    console.error(`  ✗ ${label} — FILE NOT FOUND: ${rel}`)
    failed++
    return
  }
  const t = fs.readFileSync(p, 'utf8')
  if (predicate(t)) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label} — predicate failed in ${rel}`)
    failed++
  }
}

console.log('=== Wave 151-210 Structural Checks ===\n')

// --- ads/monitor.mjs ---
assertFile('worker/src/ads/monitor.mjs',
  (t) => t.includes('META_ADS_TOKEN  = () =>') && t.includes('AD_ACCOUNT_ID   = () =>') && t.includes('AbortSignal.timeout(20_000)'),
  'ads/monitor: env getters + fetch timeout')

// --- cs/messenger-poll.mjs ---
assertFile('worker/src/cs/messenger-poll.mjs',
  (t) => /MAX_MESSAGE_AGE_MS\s*=\s*\(\)/.test(t) && t.includes('MAX_MESSAGE_AGE_MS()') && t.includes('AbortSignal.timeout(15_000)'),
  'cs/messenger-poll: runtime env + fetch timeouts')

// --- finance/daily-cashflow.mjs ---
assertFile('worker/src/finance/daily-cashflow.mjs',
  (t) => t.includes('OWNER_CHAT_ID = () =>') && t.includes('OWNER_CHAT_ID()') && !t.includes('.catch(() => {})'),
  'finance/daily-cashflow: env getter + error logging')

// --- telegram/voice.mjs ---
assertFile('worker/src/telegram/voice.mjs',
  (t) => t.includes('AbortSignal.timeout(30_000)') && t.includes('AbortSignal.timeout(60_000)'),
  'telegram/voice: download + transcribe timeouts')

// --- tts.mjs ---
assertFile('worker/src/tts.mjs',
  (t) => t.includes('AbortSignal.timeout(15_000)') && t.includes('AbortSignal.timeout(30_000)') && t.includes('timeout: 30_000') && t.includes('temp cleanup failed'),
  'tts: fetch timeouts + ffmpeg timeout + cleanup logging')

// --- reports/weekly-business-intel.mjs ---
assertFile('worker/src/reports/weekly-business-intel.mjs',
  (t) => t.includes("OWNER_CHAT_ID = () =>") && t.includes('OWNER_CHAT_ID()') && t.includes('AI report generation failed') && t.includes('staff scores JSON parse failed'),
  'weekly-bi: env getter + error logging + parse logging')

// --- staff/performance-score.mjs ---
assertFile('worker/src/staff/performance-score.mjs',
  (t) => t.includes('OWNER_CHAT_ID = () =>') && t.includes('OWNER_CHAT_ID()') && t.includes('owner send failed'),
  'performance-score: env getter + error logging')

// --- staff/geo-monitor.mjs ---
assertFile('worker/src/staff/geo-monitor.mjs',
  (t) => t.includes('OWNER_CHAT_ID = () =>') && t.includes('OWNER_CHAT_ID()') && t.includes('ghost check-in send failed'),
  'geo-monitor: env getter + error logging')

// --- security/audit-scan.mjs ---
assertFile('worker/src/security/audit-scan.mjs',
  (t) => t.includes('OWNER_CHAT_ID = () =>') && t.includes('OWNER_CHAT_ID()') && t.includes('owner send failed'),
  'audit-scan: env getter + error logging')

// --- schedulers/agent-scorecard.mjs ---
assertFile('worker/src/schedulers/agent-scorecard.mjs',
  (t) => /APP_URL\s*=\s*\(\)/.test(t) && /INT_TOKEN\s*=\s*\(\)/.test(t) && t.includes('AbortSignal.timeout(30_000)'),
  'agent-scorecard: env getters + fetch timeout')

// --- schedulers/budget-check.mjs ---
assertFile('worker/src/schedulers/budget-check.mjs',
  (t) => /APP_URL\s*=\s*\(\)/.test(t) && /INT_TOKEN\s*=\s*\(\)/.test(t) && t.includes('markAlert failed') && t.includes('AbortSignal.timeout'),
  'budget-check: env getters + error logging + timeouts')

// --- schedulers/balance-check.mjs ---
assertFile('worker/src/schedulers/balance-check.mjs',
  (t) => t.includes('AbortSignal.timeout(10_000)') && t.includes('markAlert failed'),
  'balance-check: fetch timeouts + error logging')

// --- schedulers/subscription-renewal.mjs ---
assertFile('worker/src/schedulers/subscription-renewal.mjs',
  (t) => /APP_URL\s*=\s*\(\)/.test(t) && /INT_TOKEN\s*=\s*\(\)/.test(t),
  'subscription-renewal: env getters')

// --- staff/weekly-review.mjs ---
assertFile('worker/src/staff/weekly-review.mjs',
  (t) => /APP_URL\s*=\s*\(\)/.test(t) && /INT_TOKEN\s*=\s*\(\)/.test(t) && t.includes('reply stats failed') && t.includes('outcome scorecard failed') && t.includes('AbortSignal.timeout(15_000)'),
  'weekly-review: env getters + error logging + timeouts')

// --- cs/escalation.mjs ---
assertFile('worker/src/cs/escalation.mjs',
  (t) => t.includes('staff reminder send failed') && t.includes('owner escalation send failed') && t.includes('AbortSignal.timeout(15_000)'),
  'cs/escalation: error logging + timeout')

// --- staff/presence-nudge.mjs ---
assertFile('worker/src/staff/presence-nudge.mjs',
  (t) => t.includes('send failed for') && !t.includes('.catch(() => {})'),
  'presence-nudge: error logging instead of swallowed catch')

// --- cs/shadow-notify.mjs ---
assertFile('worker/src/cs/shadow-notify.mjs',
  (t) => t.includes('draft notify API failed') && t.includes('AbortSignal.timeout(10_000)'),
  'shadow-notify: error logging + timeout')

// --- staff/lunch-watch.mjs ---
assertFile('worker/src/staff/lunch-watch.mjs',
  (t) => t.includes('ntfy send failed') && t.includes('owner 45-min alert failed') && t.includes('owner 60-min alert failed'),
  'lunch-watch: all catches now log errors')

// --- staff/morning-staff-reminder.mjs ---
assertFile('worker/src/staff/morning-staff-reminder.mjs',
  (t) => t.includes('approval escalation send failed') && t.includes('owner summary send failed'),
  'morning-staff-reminder: error logging')

// --- staff/ack-escalation.mjs ---
assertFile('worker/src/staff/ack-escalation.mjs',
  (t) => t.includes('critical ntfy failed') && t.includes('staff re-ping failed') && !t.includes('.catch(() => {})'),
  'ack-escalation: all catches now log errors')

// --- staff/evening-proposal.mjs ---
assertFile('worker/src/staff/evening-proposal.mjs',
  (t) => t.includes('no-tasks notify failed') && t.includes('smart task API failed') && t.includes('fallback notify failed'),
  'evening-proposal: error logging')

// --- cs/meta-send.mjs ---
assertFile('worker/src/cs/meta-send.mjs',
  (t) => t.includes('typing indicator failed'),
  'meta-send: typing indicator catch logs error')

// --- messenger/scan.mjs ---
assertFile('worker/src/messenger/scan.mjs',
  (t) => t.includes('cs_mode fetch failed') && t.includes('cs-is-handled check failed') && t.includes('token-missing notify failed'),
  'messenger/scan: error logging on silent catches + fetch timeout')

// --- schedulers/index.mjs ---
assertFile('worker/src/schedulers/index.mjs',
  (t) => t.includes('critical job failure notification failed') && t.includes('poll cycle failed'),
  'schedulers/index: error logging on silent catches')

// --- index.mjs ---
assertFile('worker/src/index.mjs',
  (t) => t.includes('callJobResult(failed) failed') && t.includes('dispatch fail notify failed') && t.includes('ntfy alert for bot failure also failed'),
  'index.mjs: all worker-level catches now log')

// --- night-report.mjs (additional from subagent findings) ---
assertFile('worker/src/staff/night-report.mjs',
  (t) => t.includes('salah summary failed') && t.includes('sales summary failed') && t.includes('GPS gap check failed') && t.includes('AbortSignal.timeout(15_000)'),
  'night-report: all silent catches now log + fetch timeouts')

// --- approvals/tracker.mjs ---
assertFile('worker/src/approvals/tracker.mjs',
  (t) => t.includes('expire notification to owner failed'),
  'approvals/tracker: expire notify logged')

// --- trust-engine.ts ---
assertFile('src/agent/lib/trust-engine.ts',
  (t) => t.includes('recordApproval failed') && t.includes('recordRejection failed') && t.includes('getAllTrustRules failed') && t.includes('setTrustTier failed'),
  'trust-engine: all catches now log')

// --- deploy route ---
assertFile('src/app/api/agent/vps/deploy/route.ts',
  (t) => t.includes('KV write for lastDeploy failed'),
  'deploy route: KV write failure logged')

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exit(1)
