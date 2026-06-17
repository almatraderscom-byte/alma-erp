#!/usr/bin/env node
/**
 * Smoke test — wave 101-150 structural checks.
 * Run: node worker/scripts/verify-wave-101-150.mjs
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

console.log('=== Wave 101-150 Structural Checks ===\n')

// #101 dispatch carry-forward
assertFile('worker/src/staff/dispatch.mjs',
  (t) => t.includes('carry-forward') && t.includes("eq('status', 'sent')") && t.includes('carryForward'),
  '#101 dispatch carry-forward from previous day')

// #103 staff-feedback owner notify logged
assertFile('worker/src/staff/staff-feedback.mjs',
  (t) => t.includes('console.warn') && t.includes('owner notify failed'),
  '#103 staff-feedback owner notify error logged')

// #104 proof-timeout retry + timeout
assertFile('worker/src/staff/proof-timeout.mjs',
  (t) => t.includes('AbortSignal.timeout') && t.includes('attempt < 2') && t.includes('res.ok'),
  '#104 proof-timeout retry + timeout + res.ok check')

// #106 bonus-task-suggest timeout
assertFile('worker/src/staff/bonus-task-suggest.mjs',
  (t) => t.includes('AbortSignal.timeout'),
  '#106 bonus-task-suggest fetch timeout')

// #107 productivity-monitor OWNER_CHAT_ID getter
assertFile('worker/src/staff/productivity-monitor.mjs',
  (t) => t.includes('OWNER_CHAT_ID = () =>') && t.includes('OWNER_CHAT_ID()'),
  '#107 productivity-monitor OWNER_CHAT_ID runtime getter')

// #108 pattern-detect error handling
assertFile('worker/src/staff/pattern-detect.mjs',
  (t) => t.includes('try {') && t.includes('[pattern-detect]') && t.includes('return []'),
  '#108 pattern-detect error handling')

// #109 morale owner escalation
assertFile('worker/src/staff/morale.mjs',
  (t) => t.includes('sendFails') && t.includes('সম্পূর্ণ ব্যর্থ'),
  '#109 morale owner escalation on total failure')

// #110 midday-checkin bot guard + DB error
assertFile('worker/src/staff/midday-checkin.mjs',
  (t) => t.includes("if (!bot)") && t.includes('dbErr'),
  '#110 midday-checkin bot guard + DB error handling')

// #111 approval-escalation return value
assertFile('worker/src/staff/approval-escalation.mjs',
  (t) => t.includes("dutyStatus: 'skipped'"),
  '#111 approval-escalation return value when no owner/bot')

// #112 health-ping URL masked
assertFile('worker/src/health-ping.mjs',
  (t) => t.includes('[redacted]') || t.includes('ntfyMsg') || !t.includes('URL: ${APP_URL()}'),
  '#112 health-ping internal URL masked in ntfy')

// #113 todo-reconcile only cancels scheduler/day_shift
assertFile('worker/src/schedulers/todo-reminder.mjs',
  (t) => t.includes('autoSources') && t.includes("'scheduler'") && t.includes("'day_shift'"),
  '#113 todo-reconcile only cancels scheduler-seeded tasks')

// #114 todo-reminder seed failure logged
assertFile('worker/src/schedulers/todo-reminder.mjs',
  (t) => t.includes('seed task') && t.includes('failed:'),
  '#114 todo-reminder seed failure logging')

// #115 daily-summary money rounded + env getter
assertFile('worker/src/schedulers/daily-summary.mjs',
  (t) => t.includes('Math.round(') && /APP_URL\s*=\s*\(\)\s*=>/.test(t) && /INT_TOKEN\s*=\s*\(\)\s*=>/.test(t),
  '#115 daily-summary money rounded + env getters')

// #117 messenger scan error reporting
assertFile('worker/src/messenger/scan.mjs',
  (t) => t.includes('scanErrors') && t.includes('আংশিক ব্যর্থ'),
  '#117 messenger scan error reporting to owner')

// #118 content-engine timeout + error logging
assertFile('worker/src/content-engine/run.mjs',
  (t) => t.includes('AbortSignal.timeout') && t.includes('fetchErr'),
  '#118 content-engine fetch timeout + error logging')

// #119 daily-focus context fetch logged
assertFile('worker/src/intelligence/daily-focus.mjs',
  (t) => t.includes('[daily-focus] API') && t.includes('fetch failed'),
  '#119 daily-focus context fetch errors logged')

// #121 launcher getMe verification
assertFile('worker/src/telegram/launcher.mjs',
  (t) => t.includes('getMe()') && t.includes('Bot verified'),
  '#121 launcher getMe verification after launch')

// #122 index.mjs bot fail ntfy alert
assertFile('worker/src/index.mjs',
  (t) => t.includes('telegram_boot_failed') && t.includes('Telegram bot down'),
  '#122 bot fail sends ntfy critical alert')

// #125-132 DB migration
assertFile('prisma/migrations/20260719120000_wave101_150_db_hardening/migration.sql',
  (t) => t.includes('agent_todos') && t.includes('gen_random_uuid') && t.includes('idx_agent_pending_actions_type_status') && t.includes('duty_date_format_check'),
  '#125-132 DB migration for defaults, indexes, constraints')

// #137 staff-approval-gate notify audit trail
assertFile('worker/src/approval/staff-approval-gate.mjs',
  (t) => t.includes("autoApproved: true") && t.includes("trustTier: 'notify'") && t.includes("status: 'executed'"),
  '#137 approval-gate notify tier audit trail')

// #138 ip-allowlist prefers x-real-ip
assertFile('src/lib/agent-api/ip-allowlist.ts',
  (t) => t.includes("x-real-ip") && t.indexOf("x-real-ip") < t.indexOf("x-forwarded-for"),
  '#138 ip-allowlist prefers x-real-ip over x-forwarded-for')

// #140 auto-fix dispatch timeout + res.ok check
assertFile('worker/src/auto-fix/dispatch.mjs',
  (t) => t.includes('AbortSignal.timeout(10_000)') && t.includes('!res.ok'),
  '#140 auto-fix dispatch notify timeout + res.ok check')

// #142 notify-owner log failure
assertFile('src/agent/lib/notify-owner.ts',
  (t) => t.includes('notification-log write failed'),
  '#142 notify-owner notification-log error logging')

// #143 owner-briefing-data outcome tracking logged
assertFile('src/agent/lib/owner-briefing-data.ts',
  (t) => t.includes('reorder outcome tracking failed') && t.includes('decision outcome tracking failed'),
  '#143 owner-briefing-data outcome tracking failures logged')

// #145 core.ts context fetch failures logged
assertFile('src/agent/lib/core.ts',
  (t) => t.includes('outcomeLearnings fetch failed') && t.includes('conflictSignals fetch failed') && t.includes('businessContext build failed'),
  '#145 core.ts context/outcome/conflict failures logged')

// #146 core.ts contextSummary error logged
assertFile('src/agent/lib/core.ts',
  (t) => t.includes('contextSummary load failed'),
  '#146 core.ts contextSummary error logging')

// #147 day-shift corrupt JSON logged
assertFile('src/agent/lib/day-shift.ts',
  (t) => t.includes('corrupt state JSON'),
  '#147 day-shift corrupt JSON logging')

// #148 day-shift specialist failure owner alert
assertFile('src/agent/lib/day-shift.ts',
  (t) => t.includes('specialist ব্যর্থ'),
  '#148 day-shift specialist failure owner alert')

// #149 internal/day-shift malformed body logging
assertFile('src/app/api/assistant/internal/day-shift/route.ts',
  (t) => t.includes('malformed request body'),
  '#149 internal/day-shift malformed JSON logging')

// #150 retrigger uses Prisma ORM instead of executeRawUnsafe
assertFile('src/app/api/agent/staff-monitor/retrigger/route.ts',
  (t) => !t.includes('executeRawUnsafe') && t.includes('agentKvSetting.upsert') && t.includes('instant path failed'),
  '#150 retrigger uses Prisma ORM + logs errors')

// #144 marketing report catches logged
assertFile('src/agent/lib/marketing/report.ts',
  (t) => t.includes('campaign metrics fetch failed') && t.includes('marketing intel failed'),
  '#144 marketing report .catch errors logged')

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exit(1)
