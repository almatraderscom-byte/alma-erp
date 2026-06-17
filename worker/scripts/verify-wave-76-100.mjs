#!/usr/bin/env node
/**
 * Smoke test: wave 76–100 structural locks.
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, existsSync } from 'fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
dotenv.config({ path: join(root, 'worker/.env'), override: true })

let passed = 0
let failed = 0

function ok(l) { passed++; console.log(`  ✓ ${l}`) }
function fail(l, d = '') { failed++; console.error(`  ✗ ${l}${d ? ` — ${d}` : ''}`) }

function assertFile(rel, check, label) {
  const p = join(root, rel)
  if (!existsSync(p)) return fail(label, `missing ${rel}`)
  if (check(readFileSync(p, 'utf8'))) ok(label)
  else fail(label)
}

console.log('\n[wave-76-100] structural checks\n')

// #76 command-defaults uses telegramChatId (not telegram_chat_id)
assertFile('worker/src/telegram/command-defaults.mjs', (t) =>
  t.includes('telegramChatId') && !t.includes('telegram_chat_id'), '#76 command-defaults column name')

// #77 sentry captureWorkerError handles swapped arg order
assertFile('worker/src/sentry.mjs', (t) =>
  t.includes('typeof errOrEvent') && t.includes("=== 'string'"), '#77 sentry arg order resilient')

// #78 long-agent-task attempts > 1
assertFile('worker/src/index.mjs', (t) =>
  t.includes("'long-agent-task'") && t.includes('attempts: 2'), '#78 long_agent_task retry')

// #79 daily-focus reads agent_todos (primary) not just agent_owner_todos
assertFile('worker/src/intelligence/daily-focus.mjs', (t) =>
  t.includes('agent_todos') && t.includes('agent_owner_todos'), '#79 daily-focus reads both todo tables')

// #80 staff_approve atomic claim (updateMany or .update+.in)
assertFile('worker/src/telegram/index.mjs', (t) =>
  t.includes("staff_approve:") && t.includes(".in('status'"), '#80 staff_approve atomic claim')

// #82 floodBuckets pruned
assertFile('worker/src/telegram/index.mjs', (t) =>
  t.includes('floodBuckets.size > 200'), '#82 floodBuckets memory prune')

// #84 alertCooldowns pruned
assertFile('worker/src/staff/geo-monitor.mjs', (t) =>
  t.includes('alertCooldowns.size > 200'), '#84 alertCooldowns memory prune')

// #85 daily-focus OWNER_CHAT_ID runtime
assertFile('worker/src/intelligence/daily-focus.mjs', (t) =>
  t.includes('OWNER_CHAT_ID = ()') || t.includes('OWNER_CHAT_ID()'), '#85 daily-focus owner ID runtime')

// #89 postlink_skip owner guard
assertFile('worker/src/telegram/index.mjs', (t) =>
  t.includes('postlink_skip') && t.includes('isOwner') && t.includes('cs_edit'), '#89-90 postlink/cs_edit owner guard')

// #91 approve: callback has isOwner
assertFile('worker/src/telegram/index.mjs', (t) => {
  const idx = t.indexOf("data.startsWith('approve:')")
  if (idx === -1) return false
  const nearby = t.slice(idx, idx + 200)
  return nearby.includes('isOwner')
}, '#91 approve: owner guard')

// #92 duplicate_campaign sets failed on error
assertFile('src/app/api/assistant/actions/[id]/approve/route.ts', (t) =>
  t.includes('duplicate_campaign') && t.includes("status: 'failed'"), '#92 duplicate_campaign fail status')

// #94 approve expiry uses isPendingActionExpired
assertFile('src/app/api/assistant/actions/[id]/approve/route.ts', (t) =>
  t.includes('isPendingActionExpired'), '#94 approve expiry dedup')

// #96 health probe returns dbError detail
assertFile('src/app/api/assistant/internal/health/route.ts', (t) =>
  t.includes('dbError'), '#96 health probe detail')

// #97 todo toggle handles in_progress/running
assertFile('src/agent/components/AgentTodoPanel.tsx', (t) =>
  t.includes('in_progress') && t.includes('running'), '#97 todo toggle in_progress')

// #98 failed todos filtered from active
assertFile('src/agent/components/AgentTodoPanel.tsx', (t) =>
  t.includes("'failed'") && t.includes('cancelled'), '#98 failed todos filtered')

// #99 context active filter excludes failed
assertFile('src/agent/components/AgentTodoContext.tsx', (t) =>
  t.includes("'failed'") && t.includes("'in_progress'"), '#99 context status consistency')

// #100 model selector fallback
assertFile('src/agent/components/AgentModelSelector.tsx', (t) =>
  t.includes('DEFAULT_MODEL_ID') && t.includes('catch'), '#100 model selector fallback')

// #66 content_gate1 fail revert (from wave 51-75, re-verify)
assertFile('src/app/api/assistant/actions/[id]/approve/route.ts', (t) =>
  t.includes("status: 'failed'") && t.includes('content_gate1'), '#66 gate1 fail revert (re-verify)')

console.log(`\n[wave-76-100] ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
