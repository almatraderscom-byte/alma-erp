#!/usr/bin/env node
/**
 * Smoke test: wave 51–75 structural locks.
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

console.log('\n[wave-51-75] structural checks\n')

assertFile('worker/src/approval/staff-approval-gate.mjs', (t) => t.includes('cardSent') && t.includes('if (!cardSent)'), '#51 gate orphan guard')
assertFile('worker/src/schedulers/index.mjs', (t) => t.includes('*/5 * * * *') && t.includes('staff-approval-escalation'), '#52 escalation 5min cron')
assertFile('worker/src/approval/escalation-poller.mjs', (t) => t.includes('res.ok') && !t.includes('shouldCall) {\n      await supabase'), '#53 call after success')
assertFile('worker/src/staff/ack-escalation.mjs', (t) => t.includes('ownerNotified'), '#54 ack only on notify success')
assertFile('worker/src/index.mjs', (t) => t.includes('enqueuedIds.delete') && t.includes("on('completed'"), '#55 enqueuedIds clear on success')
assertFile('worker/src/index.mjs', (t) => t.includes("csReplyWorker.on('completed'"), '#56 csEnqueued clear on success')
assertFile('worker/src/index.mjs', (t) => t.includes('videoGenWorker.close'), '#57 video worker shutdown')
assertFile('worker/src/index.mjs', (t) => t.includes('retriggerPoll'), '#58 scheduler polls cleared')
assertFile('worker/src/schedulers/index.mjs', (t) => t.includes('concurrency: 1'), '#59 scheduler concurrency 1')
assertFile('worker/src/schedulers/index.mjs', (t) => t.includes('existingByName') || t.includes('pattern === entry.cronUtc'), '#60 no blind cron wipe')
assertFile('worker/src/telegram/index.mjs', (t) => t.includes("timeZone: 'Asia/Dhaka'"), '#61 Dhaka daily conversation')
assertFile('worker/src/schedulers/catchup.mjs', (t) => t.includes('একটি সারাংশ') && t.includes('notifyOwner === true'), '#74 catchup honest summary')
assertFile('worker/src/index.mjs', (t) => t.includes('loadOwnerStateFromKv'), '#62 owner state load on boot')
assertFile('worker/src/telegram/agent-turn.mjs', (t) => t.includes('persistOwnerStateToKv'), '#62 owner state persist on turn')
assertFile('worker/src/staff/task-verification.mjs', (t) => t.includes('hydrateAwaitingProof'), '#63 proof maps hydrate')
assertFile('worker/src/index.mjs', (t) => t.includes('attempt < 3') || t.includes('MAX_JOB_RESULT_RETRIES'), '#64 job-result retry')
assertFile('worker/src/index.mjs', (t) => t.includes('await callJobResult'), '#65 image-gen await callback')
assertFile('src/app/api/assistant/actions/[id]/approve/route.ts', (t) => t.includes("status: 'failed'") && t.includes('content_gate1'), '#66 gate1 fail revert')
assertFile('src/lib/content-engine/ad-creative-gate.ts', (t) => t.includes('updateMany') && t.includes('pending'), '#67 ad gate lock')
assertFile('src/app/api/assistant/actions/[id]/approve/route.ts', (t) => t.includes("'auto_fix'"), '#68 auto_fix approve')
assertFile('src/app/api/assistant/chat/route.ts', (t) => t.includes("conv.source !== 'telegram'") || t.includes("source !== 'telegram'"), '#69 internal chat IDOR guard')
assertFile('src/lib/agent-api/auth.ts', (t) => t.includes('timingSafeEqual'), '#70 timing-safe API key')
assertFile('src/app/api/agent/health-scan/route.ts', (t) => t.includes('timingSafeEqual') || t.includes('verifyAgentInternalToken'), '#71 health-scan timing-safe')
assertFile('worker/src/staff/geo-monitor.mjs', (t) => t.includes('officeCoordsConfigured'), '#72 geo skip if unset')
assertFile('worker/src/staff/morning-staff-reminder.mjs', (t) => t.includes('dispatch_staff_tasks'), '#73 morning gate check')
assertFile('worker/src/staff/evening-proposal.mjs', (t) => t.includes('normalizeStaffTaskType'), '#75 task type normalize')
assertFile('worker/src/staff/evening-proposal.mjs', (t) => t.includes("from './task-type.mjs'"), '#75 task-type import')

console.log(`\n[wave-51-75] ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
