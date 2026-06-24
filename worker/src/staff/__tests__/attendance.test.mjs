/**
 * Regression lock for the attendance gate.
 *
 * The historic bug: getCheckedInMap queried a non-existent snake_case table
 * (`attendance_records`) with snake_case columns and joined the HR code
 * (`employeeId`) against agent_staff.user_id — a match that ALWAYS fails. That
 * silently emptied every check-in-gated job (presence, midday, greeting…).
 *
 * These tests pin the contract: real table `AttendanceRecord`, camelCase columns,
 * and the `userId` join. Run with:  node --test src/staff/__tests__/attendance.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getCheckedInMap, nextDhakaDate, dhakaToday } from '../attendance.mjs'

/**
 * Minimal chainable Supabase stub. Every filter method records its call and
 * returns `this`; the builder is awaitable (resolves to { data, error }) and
 * also supports the .order().limit().maybeSingle() tail.
 */
function makeSupabase(rows) {
  const calls = { table: null, select: null, filters: [] }
  const builder = {
    select(cols) { calls.select = cols; return builder },
    in(col, vals) { calls.filters.push(['in', col, vals]); return builder },
    eq(col, val) { calls.filters.push(['eq', col, val]); return builder },
    gte(col, val) { calls.filters.push(['gte', col, val]); return builder },
    lt(col, val) { calls.filters.push(['lt', col, val]); return builder },
    order() { return builder },
    limit() { return builder },
    maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }) },
    then(resolve) { resolve({ data: rows, error: null }); },
  }
  const supabase = {
    from(table) { calls.table = table; return builder },
  }
  return { supabase, calls }
}

test('getCheckedInMap queries AttendanceRecord with camelCase cols and userId join', async () => {
  const staffList = [
    { id: 'staff-A', user_id: 'user-1' },
    { id: 'staff-B', user_id: 'user-2' },
  ]
  const rows = [
    { userId: 'user-1', checkInAt: '2026-06-24T03:10:00.000Z' },
    { userId: 'user-2', checkInAt: '2026-06-24T03:25:00.000Z' },
  ]
  const { supabase, calls } = makeSupabase(rows)

  const map = await getCheckedInMap(supabase, staffList)

  assert.equal(calls.table, 'AttendanceRecord', 'must query the real PascalCase table')
  assert.equal(calls.select, 'userId, checkInAt', 'must select camelCase columns')

  const inCall = calls.filters.find((f) => f[0] === 'in')
  assert.ok(inCall, 'must filter by a set of ids')
  assert.equal(inCall[1], 'userId', 'join column MUST be userId, never employeeId')
  assert.deepEqual(inCall[2], ['user-1', 'user-2'])

  assert.ok(calls.filters.some((f) => f[0] === 'eq' && f[1] === 'businessId'), 'must scope by businessId')

  // Result is keyed by agent_staff.id, values are Dates.
  assert.equal(map.size, 2)
  assert.ok(map.get('staff-A') instanceof Date)
  assert.equal(map.get('staff-A').toISOString(), '2026-06-24T03:10:00.000Z')
  assert.ok(map.get('staff-B') instanceof Date)
})

test('getCheckedInMap returns empty map without querying when no user_ids', async () => {
  const { supabase, calls } = makeSupabase([])
  const map = await getCheckedInMap(supabase, [{ id: 'x', user_id: null }])
  assert.equal(map.size, 0)
  assert.equal(calls.table, null, 'should not hit the DB when there is nothing to join on')
})

test('getCheckedInMap excludes staff whose row has no checkInAt', async () => {
  const staffList = [
    { id: 'staff-A', user_id: 'user-1' },
    { id: 'staff-B', user_id: 'user-2' },
  ]
  const rows = [
    { userId: 'user-1', checkInAt: '2026-06-24T03:10:00.000Z' },
    { userId: 'user-2', checkInAt: null },
  ]
  const { supabase } = makeSupabase(rows)
  const map = await getCheckedInMap(supabase, staffList)
  assert.ok(map.has('staff-A'))
  assert.ok(!map.has('staff-B'), 'no checkInAt = not checked in')
})

test('nextDhakaDate returns the following calendar day (exclusive upper bound)', () => {
  assert.equal(nextDhakaDate('2026-06-24'), '2026-06-25')
  assert.equal(nextDhakaDate('2026-12-31'), '2027-01-01')
  assert.equal(nextDhakaDate('2026-02-28'), '2026-03-01')
})

test('dhakaToday yields a YYYY-MM-DD string', () => {
  assert.match(dhakaToday(), /^\d{4}-\d{2}-\d{2}$/)
})
