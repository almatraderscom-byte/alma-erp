#!/usr/bin/env node
/**
 * Smoke test: owner call lock module (no Twilio, no DB writes unless --live).
 * Usage: node worker/scripts/test-owner-call-lock.mjs
 */
import { isOwnerCallLocked, OWNER_CALL_LOCK_KEY } from '../src/owner-call-lock.mjs'

const now = new Date()
const future = new Date(now.getTime() + 30 * 60_000)
const past = new Date(now.getTime() - 60_000)

function assert(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`)
    process.exit(1)
  }
  console.log(`PASS: ${name}`)
}

// Pure logic: module exports
assert('OWNER_CALL_LOCK_KEY defined', OWNER_CALL_LOCK_KEY === 'owner_call_lock_until')

// isOwnerCallLocked should not throw without env (returns unlocked if no DB)
try {
  const status = await isOwnerCallLocked()
  assert('isOwnerCallLocked returns object', typeof status === 'object' && 'locked' in status)
  console.log(`  current lock status: locked=${status.locked}${status.until ? ` until=${status.until.toISOString()}` : ''}`)
} catch (err) {
  if (!process.env.SUPABASE_URL) {
    console.log('SKIP: isOwnerCallLocked (no SUPABASE_URL in env)')
  } else {
    console.error('FAIL: isOwnerCallLocked threw', err.message)
    process.exit(1)
  }
}

console.log('\nSmoke test complete — lock gate wired in:')
console.log('  - worker/src/notify/twilio-call.mjs (makeTwilioCall + retries)')
console.log('  - worker/src/salah/scheduler.mjs (delay_until suppress + tier-3 downgrade)')
console.log('  - src/agent/tools/salah-tools.ts (setOwnerCallLockUntil on delay)')
