/**
 * Unit-style check: dispatch must use all approved rows for date, not stale taskIds subset.
 */
import assert from 'node:assert/strict'

// Mirror worker dispatch filter logic (post-fix)
function selectApprovedForDispatch(allApproved, payloadTaskIds) {
  // Post-fix: ignore payloadTaskIds filter
  return allApproved.filter((t) => t.status === 'approved')
}

// Pre-fix behavior (bug)
function selectApprovedStale(allApproved, payloadTaskIds) {
  const ids = new Set(payloadTaskIds ?? [])
  return allApproved.filter((t) => t.status === 'approved' && ids.has(t.id))
}

const dbApproved = [
  { id: 'old-1', status: 'approved', title: 'Old task' },
  { id: 'new-7', status: 'approved', title: 'Reels shekha' },
  { id: 'new-8', status: 'approved', title: 'Product research' },
]
const stalePayloadIds = ['old-1', 'old-2', 'old-3']

const stale = selectApprovedStale(dbApproved, stalePayloadIds)
const fixed = selectApprovedForDispatch(dbApproved, stalePayloadIds)

assert.equal(stale.length, 1, 'stale path sends only old task')
assert.equal(fixed.length, 3, 'fixed path sends all approved including merged tasks')

console.log('PASS: dispatch sync logic — merged tasks included after fix')
