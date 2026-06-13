#!/usr/bin/env node
/**
 * Verify task verification module structure (no live Telegram).
 */
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let ok = 0
let fail = 0

function assert(cond, msg) {
  if (cond) { ok++; console.log(`✅ ${msg}`) }
  else { fail++; console.log(`❌ ${msg}`) }
}

const files = [
  'worker/src/staff/verify-task.mjs',
  'worker/src/staff/task-verification.mjs',
  'worker/src/staff/proof-timeout.mjs',
  'src/agent/lib/task-verification.ts',
  'src/app/api/assistant/internal/task-callback/route.ts',
  'src/app/api/assistant/internal/task-verify-erp/route.ts',
  'prisma/migrations/20260618120000_staff_task_verification/migration.sql',
]

for (const f of files) {
  assert(existsSync(join(root, f)), `exists ${f}`)
}

const migration = readFileSync(join(root, 'prisma/migrations/20260618120000_staff_task_verification/migration.sql'), 'utf8')
assert(!migration.includes('::'), 'migration has no :: casts')
assert(migration.includes('verification_status'), 'migration adds verification_status')
assert(migration.includes('awaiting_proof'), 'migration adds awaiting_proof status')

const cb = readFileSync(join(root, 'src/app/api/assistant/internal/task-callback/route.ts'), 'utf8')
assert(cb.includes("action === 'approve'"), 'task-callback approve action')
assert(cb.includes("action === 'redo'"), 'task-callback redo action')
assert(cb.includes('instant: true'), 'instant-done bypass when verification off')

const verify = readFileSync(join(root, 'worker/src/staff/verify-task.mjs'), 'utf8')
assert(verify.includes('autoVerifyTask'), 'verify-task exports autoVerifyTask')
assert(verify.includes('checkFbPageActivity'), 'FB page check present')

const idx = readFileSync(join(root, 'worker/src/telegram/index.mjs'), 'utf8')
assert(idx.includes('task_vfy_ok:'), 'owner approve callback')
assert(idx.includes('task_vfy_redo:'), 'owner redo callback')
assert(idx.includes('handleStaffProofMessage'), 'staff proof photo handler')

const today = readFileSync(join(root, 'worker/src/telegram/quick-commands.mjs'), 'utf8')
assert(today.includes('taskDisplayIcon'), '/today verification icons')

console.log(`\n=== ${ok} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
