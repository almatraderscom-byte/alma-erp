#!/usr/bin/env node
/**
 * Attendance check-in regression — blocks deploy when attendance API contract breaks.
 */
import { loadRegressionEnvFiles } from './regression-env.mjs'
import { resolveRegressionCookie } from './regression-resolve-auth.mjs'

loadRegressionEnvFiles()

const BASE = (process.env.REGRESSION_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
const BUSINESS = process.env.REGRESSION_BUSINESS_ID || 'ALMA_LIFESTYLE'
let COOKIE = process.env.REGRESSION_COOKIE || ''

const failures = []
const criticalFailures = []

function fail(msg, critical = true) {
  console.error(`[FAIL] ${msg}`)
  failures.push(msg)
  if (critical) criticalFailures.push(msg)
}

function pass(msg) {
  console.log(`[OK] ${msg}`)
}

async function safeParseJson(res) {
  const text = await res.text()
  if (!text.trim()) return { parseError: true, reason: 'empty_body', body: {} }
  if (/^\s*</.test(text)) return { parseError: true, reason: 'html_body', body: {}, snippet: text.slice(0, 120) }
  try {
    return { parseError: false, body: JSON.parse(text) }
  } catch {
    return { parseError: true, reason: 'invalid_json', body: {}, snippet: text.slice(0, 120) }
  }
}

async function fetchJson(path, init = {}) {
  const headers = {
    Accept: 'application/json',
    ...(init.headers || {}),
  }
  if (COOKIE) headers.Cookie = COOKIE
  const res = await fetch(`${BASE}${path}`, { ...init, headers, cache: 'no-store' })
  const parsed = await safeParseJson(res)
  return { res, parsed }
}

async function ensureAuth() {
  if (COOKIE) return true
  const hasCreds =
    (process.env.REGRESSION_IDENTIFIER || process.env.REGRESSION_EMAIL) &&
    process.env.REGRESSION_PASSWORD
  if (!hasCreds) {
    fail('No REGRESSION_COOKIE or REGRESSION_IDENTIFIER+REGRESSION_PASSWORD for attendance smoke', true)
    return false
  }
  try {
    const resolved = await resolveRegressionCookie(BASE)
    COOKIE = resolved.cookie
    console.log(`[auth] Session resolved via ${resolved.source}`)
    return true
  } catch (e) {
    fail(`Could not obtain regression session: ${e?.message || String(e)}`, true)
    return false
  }
}

async function testAttendanceMeRead() {
  const { res, parsed } = await fetchJson(
    `/api/attendance?business_id=${encodeURIComponent(BUSINESS)}&scope=me`,
    { method: 'GET' },
  )
  if (parsed.parseError) {
    fail(`attendance_me_read: ${parsed.reason} status=${res.status}`, true)
    return
  }
  if (res.status === 401) {
    fail('attendance_me_read: unauthorized — refresh regression auth', true)
    return
  }
  if (!res.ok && parsed.body?.ok !== true) {
    fail(`attendance_me_read: HTTP ${res.status} without success envelope`, true)
    return
  }
  pass('attendance_me_read: valid JSON contract')
}

async function testCheckInValidation() {
  const requestId = `regression-${Date.now()}`
  const { res, parsed } = await fetchJson('/api/attendance/check-in', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    },
    body: JSON.stringify({
      business_id: BUSINESS,
      request_id: requestId,
      metadata: { sessionId: requestId },
    }),
  })
  if (parsed.parseError) {
    fail(`attendance_checkin_validation: ${parsed.reason} status=${res.status}`, true)
    return
  }
  if (parsed.body?.ok === false && parsed.body?.error?.message) {
    pass(`attendance_checkin_validation: structured failure (${parsed.body.error.message})`)
    return
  }
  if (res.status >= 500) {
    fail(`attendance_checkin_validation: server error HTTP ${res.status}`, true)
    return
  }
  fail(`attendance_checkin_validation: expected structured 4xx failure, got HTTP ${res.status}`, true)
}

async function testCheckInEmptyBody() {
  const { res, parsed } = await fetchJson('/api/attendance/check-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '',
  })
  if (parsed.parseError && parsed.reason === 'empty_body') {
    pass('attendance_checkin_empty_body: empty body detected (client-safe)')
    return
  }
  if (parsed.body?.ok === false) {
    pass('attendance_checkin_empty_body: structured JSON failure')
    return
  }
  fail(`attendance_checkin_empty_body: unexpected response status=${res.status}`, true)
}

async function testAttendanceAdminRead() {
  const { res, parsed } = await fetchJson(
    `/api/attendance?business_id=${encodeURIComponent(BUSINESS)}`,
    { method: 'GET' },
  )
  if (parsed.parseError) {
    fail(`attendance_admin_read: ${parsed.reason}`, true)
    return
  }
  if (!res.ok) {
    if (res.status === 403) {
      pass('attendance_admin_read: forbidden for regression user (acceptable)')
      return
    }
    fail(`attendance_admin_read: HTTP ${res.status}`, true)
    return
  }
  pass('attendance_admin_read: valid JSON')
}

async function testApprovalsUnaffected() {
  const { res, parsed } = await fetchJson('/api/approvals?summary=1', { method: 'GET' })
  if (parsed.parseError) {
    fail(`approvals_unaffected: ${parsed.reason}`, true)
    return
  }
  if (!res.ok) {
    fail(`approvals_unaffected: HTTP ${res.status}`, true)
    return
  }
  pass('approvals_unaffected: still returns JSON')
}

async function main() {
  console.log(`Attendance regression → ${BASE}`)
  if (!(await ensureAuth())) process.exit(1)

  await testAttendanceMeRead()
  await testCheckInValidation()
  await testCheckInEmptyBody()
  await testAttendanceAdminRead()
  await testApprovalsUnaffected()

  if (criticalFailures.length) {
    console.error('\n━━ ATTENDANCE CRITICAL FAILURES ━━')
    criticalFailures.forEach(f => console.error(`  • ${f}`))
    process.exit(1)
  }
  if (failures.length) {
    console.error('\nAttendance regression had failures.')
    process.exit(1)
  }
  console.log('\n✓ Attendance regression smoke passed.')
}

main()
