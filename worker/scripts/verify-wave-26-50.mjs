#!/usr/bin/env node
/**
 * Smoke test: wave 26–50 structural locks.
 * Run on VPS after deploy: node worker/scripts/verify-wave-26-50.mjs
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, existsSync } from 'fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
dotenv.config({ path: join(root, 'worker/.env'), override: true })

const WAVE_FILES = [
  'worker/src/telegram/index.mjs',
  'worker/src/staff/dispatch.mjs',
  'worker/src/telegram/agent-turn.mjs',
  'worker/src/content-engine/run.mjs',
  'worker/src/finance/index.mjs',
  'worker/src/ads/optimizer.mjs',
  'worker/src/approvals/resend-card.mjs',
  'worker/src/reminders/ticker.mjs',
  'worker/src/reminders/callbacks.mjs',
  'worker/src/schedulers/todo-reminder.mjs',
  'worker/src/schedulers/balance-check.mjs',
  'worker/src/schedulers/cost-reconcile.mjs',
  'worker/src/staff/rotation.mjs',
  'worker/src/staff/verify-task.mjs',
  'worker/src/staff/task-verification.mjs',
  'worker/src/telegram/quick-commands.mjs',
  'worker/src/auto-fix/error-collector.mjs',
  'worker/src/auto-fix/dispatch.mjs',
]

const BAD_CACHE_RE = /^const APP_URL\s*=\s*process\.env\.APP_URL/m
const BAD_OWNER_RE = /^const OWNER_CHAT_ID\s*=\s*process\.env/m

let passed = 0
let failed = 0

function ok(l) { passed++; console.log(`  ✓ ${l}`) }
function fail(l, d = '') { failed++; console.error(`  ✗ ${l}${d ? ` — ${d}` : ''}`) }

function assertFile(rel, check, label) {
  const p = join(root, rel)
  if (!existsSync(p)) return fail(label, `missing ${rel}`)
  const text = readFileSync(p, 'utf8')
  if (check(text)) ok(label)
  else fail(label)
}

console.log('\n[wave-26-50] structural checks\n')

assertFile('worker/src/index.mjs', (t) => t.includes("import './env-bootstrap.mjs'"), '#26 env-bootstrap first')
assertFile('worker/src/env.mjs', (t) => t.includes('getAppUrl'), '#26-43 central env.mjs')

for (const rel of WAVE_FILES) {
  const base = rel.split('/').pop()
  assertFile(rel, (t) => t.includes('getAppUrl') || t.includes("from '../env.mjs'") || t.includes("from '../../env.mjs'"), `${base} uses runtime env`)
  assertFile(rel, (t) => !BAD_CACHE_RE.test(t), `${base} no cached APP_URL const`)
}

assertFile('worker/src/auto-fix/dispatch.mjs', (t) => t.includes('getOwnerChatId') && !BAD_OWNER_RE.test(t), '#44 runtime owner id')
assertFile('worker/src/staff/bonus-task-suggest.mjs', (t) => !t.includes("source: 'bonus_suggest'") && t.includes('normalizeStaffTaskSource'), '#46 bonus source valid')
assertFile('worker/src/staff/night-report.mjs', (t) => !t.includes("'general'") && t.includes('normalizeStaffTaskType'), '#47 night-report task type')
assertFile('worker/src/staff/dispatch.mjs', (t) => t.includes('idSet') && !t.includes('using all approved'), '#50 dispatch taskIds filter')
assertFile('worker/src/staff/bonus-task-suggest.mjs', (t) => t.includes('business_id'), '#48-49 bonus business_id')
assertFile('worker/src/staff/evening-proposal.mjs', (t) => t.includes('business_id'), '#48 evening-proposal business_id')

console.log(`\n[wave-26-50] ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
