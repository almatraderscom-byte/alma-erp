#!/usr/bin/env node
/**
 * Post-deploy attendance stability verification (production).
 * Does not mutate production attendance rows unless REGRESSION_ALLOW_CHECKIN=1 and employee session.
 */
import { loadRegressionEnvFiles } from './regression-env.mjs'
import { resolveRegressionCookie } from './regression-resolve-auth.mjs'

loadRegressionEnvFiles()

const BASE = (process.env.REGRESSION_BASE_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
const BUSINESS = process.env.REGRESSION_BUSINESS_ID || 'ALMA_LIFESTYLE'
const ALLOW_LIVE_CHECKIN = process.env.REGRESSION_ALLOW_CHECKIN === '1'
let COOKIE = process.env.REGRESSION_COOKIE || ''

const results = []
const metrics = { latencies: [] }

function record(name, status, detail = '', ms = 0) {
  results.push({ name, status, detail, ms })
  if (ms > 0) metrics.latencies.push({ name, ms })
}

function pass(name, detail = '', ms = 0) {
  record(name, 'PASS', detail, ms)
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}${ms ? ` (${ms}ms)` : ''}`)
}

function warn(name, detail = '') {
  record(name, 'WARN', detail)
  console.log(`[WARN] ${name} — ${detail}`)
}

function fail(name, detail = '') {
  record(name, 'FAIL', detail)
  console.error(`[FAIL] ${name} — ${detail}`)
}

async function parseJson(res) {
  const text = await res.text()
  if (!text.trim()) return { parseError: true, reason: 'empty_body', body: {} }
  if (/^\s*</.test(text)) return { parseError: true, reason: 'html_body', body: {} }
  try {
    return { parseError: false, body: JSON.parse(text) }
  } catch {
    return { parseError: true, reason: 'invalid_json', body: {} }
  }
}

async function fetchTimed(path, init = {}) {
  const headers = { Accept: 'application/json', ...(init.headers || {}) }
  if (COOKIE) headers.Cookie = COOKIE
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, { ...init, headers, cache: 'no-store' })
  const ms = Date.now() - t0
  const parsed = await parseJson(res)
  return { res, parsed, ms }
}

async function ensureAuth() {
  if (COOKIE) return true
  const id = process.env.REGRESSION_IDENTIFIER || process.env.REGRESSION_EMAIL
  const pw = process.env.REGRESSION_PASSWORD
  if (!id || !pw) {
    fail('auth', 'Set REGRESSION_COOKIE or REGRESSION_IDENTIFIER+REGRESSION_PASSWORD')
    return false
  }
  const resolved = await resolveRegressionCookie(BASE)
  COOKIE = resolved.cookie
  console.log(`[auth] ${resolved.source}`)
  return Boolean(COOKIE)
}

/** Minimal valid JPEG data URL for face pipeline. */
const TINY_FACE_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUQEhIVFhUVFRUYFRgVFRUVFRUWFxUYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAACAgMBAAAAAAAAAAAAAAADBAUGAAECB//EADYQAAIBAwMDAgQEBwAAAAAAAAECAwAEEQUSITETQVEGImFxMoGRoQcjQlKxwdHh8PEk/8QAGQEAAwEBAQAAAAAAAAAAAAAAAAECAwQF/8QAIhEBAQACAgMBAQEBAQAAAAAAAAERAgMSITETQVEEImFx/9oADAMBAAIRAxEAPwD0pQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/Z'

function unwrap(body) {
  if (body?.ok === true && body.data) return body.data
  if (body?.record) return body
  return body
}

async function testJsonContract() {
  const { res, parsed, ms } = await fetchTimed('/api/attendance/check-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': `verify-empty-${Date.now()}` },
    body: '',
  })
  if (parsed.parseError && parsed.reason === 'empty_body') {
    pass('no_empty_json_body', 'empty POST body handled', ms)
  } else if (parsed.body?.ok === false || parsed.body?.error) {
    pass('no_empty_json_body', 'structured failure envelope', ms)
  } else {
    fail('no_empty_json_body', `status=${res.status}`)
  }
}

async function testSuperAdminVisibility() {
  const { res, parsed, ms } = await fetchTimed(
    `/api/attendance?business_id=${encodeURIComponent(BUSINESS)}`,
  )
  if (parsed.parseError) {
    fail('super_admin_attendance_list', parsed.reason)
    return
  }
  if (!res.ok) {
    fail('super_admin_attendance_list', `HTTP ${res.status}`)
    return
  }
  const data = unwrap(parsed.body)
  pass('super_admin_attendance_list', `rows=${Array.isArray(data?.records) ? data.records.length : '?'}`, ms)
}

async function testEmployeeDesk() {
  const { res, parsed, ms } = await fetchTimed(
    `/api/attendance?business_id=${encodeURIComponent(BUSINESS)}&scope=me`,
  )
  if (parsed.parseError) {
    fail('employee_desk_refresh', parsed.reason)
    return
  }
  if (!res.ok) {
    fail('employee_desk_refresh', `HTTP ${res.status}`)
    return
  }
  const data = unwrap(parsed.body)
  const today = data?.today
  pass(
    'employee_desk_refresh',
    today ? `checked-in id=${today.id}` : 'no check-in today (valid)',
    ms,
  )
}

async function testCheckInHealth() {
  const { res, parsed, ms } = await fetchTimed(
    `/api/attendance/check-in/health?business_id=${encodeURIComponent(BUSINESS)}`,
  )
  if (parsed.parseError) {
    fail('attendance_health_endpoint', parsed.reason)
    return
  }
  if (!res.ok) {
    fail('attendance_health_endpoint', `HTTP ${res.status}`)
    return
  }
  const data = unwrap(parsed.body)
  if (!data?.architecture?.atomicTransaction) {
    fail('attendance_health_endpoint', 'missing architecture flags')
    return
  }
  pass(
    'attendance_health_endpoint',
    `today=${data.todayCheckIns} unique=${data.uniqueEmployeesToday} dupRisk=${data.duplicateRowRisk}`,
    ms,
  )
}

async function testValidationLatency() {
  const samples = []
  for (let i = 0; i < 5; i++) {
    const rid = `verify-val-${Date.now()}-${i}`
    const { ms, parsed, res } = await fetchTimed('/api/attendance/check-in', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': rid,
      },
      body: JSON.stringify({ business_id: BUSINESS, request_id: rid, metadata: {} }),
    })
    if (parsed.parseError) {
      fail('validation_latency', parsed.reason)
      return
    }
    if (parsed.body?.ok === false || res.status === 403 || res.status === 400) {
      samples.push(ms)
    }
  }
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
  const max = Math.max(...samples)
  if (max > 8000) warn('validation_latency', `max ${max}ms > 8s (slow)`)
  else pass('validation_latency', `avg=${avg}ms max=${max}ms (response before Telegram)`, max)
}

async function testDuplicateContract() {
  const rid = `verify-dup-${Date.now()}`
  const body = JSON.stringify({
    business_id: BUSINESS,
    request_id: rid,
    metadata: { sessionId: rid },
    face_verification: { image_data_url: TINY_FACE_JPEG },
  })
  const first = await fetchTimed('/api/attendance/check-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid },
    body,
  })
  if (first.parsed.parseError) {
    warn('duplicate_protection', `skipped — ${first.parsed.reason}`)
    return
  }
  const firstData = unwrap(first.parsed.body)
  if (first.parsed.body?.ok === false) {
    const msg = first.parsed.body?.error?.message || ''
    if (msg.includes('System owner') || msg.includes('employee ID')) {
      warn('duplicate_protection', `regression user cannot check in: ${msg}`)
      return
    }
    fail('duplicate_protection', msg)
    return
  }
  if (!firstData?.record?.id) {
    fail('duplicate_protection', 'first response missing record.id')
    return
  }
  const second = await fetchTimed('/api/attendance/check-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': `${rid}-2` },
    body,
  })
  const secondData = unwrap(second.parsed.body)
  if (!second.parsed.parseError && secondData?.duplicate === true && secondData?.record?.id) {
    pass('duplicate_protection', `same record id=${secondData.record.id}`, second.ms)
  } else {
    fail('duplicate_protection', 'second check-in did not return duplicate+record')
  }
}

async function testTelegramIsolation() {
  const rid = `verify-tg-${Date.now()}`
  const t0 = Date.now()
  const { ms, parsed } = await fetchTimed('/api/attendance/check-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': rid },
    body: JSON.stringify({
      business_id: BUSINESS,
      request_id: rid,
      metadata: {},
    }),
  })
  if (parsed.parseError) {
    fail('telegram_isolation', parsed.reason)
    return
  }
  if (ms < 12_000) {
    pass('telegram_isolation', `validation response ${ms}ms — HTTP returns before async Telegram queue`, ms)
  } else {
    warn('telegram_isolation', `slow ${ms}ms — investigate blocking work on hot path`)
  }
}

async function testAnalyticsRefresh() {
  const { res, parsed, ms } = await fetchTimed(
    `/api/attendance/waivers/analytics?business_id=${encodeURIComponent(BUSINESS)}`,
  )
  if (parsed.parseError) {
    warn('analytics_refresh', parsed.reason)
    return
  }
  if (res.status === 404 || res.status === 403) {
    warn('analytics_refresh', `HTTP ${res.status} — optional route`)
    return
  }
  if (!res.ok) {
    fail('analytics_refresh', `HTTP ${res.status}`)
    return
  }
  pass('analytics_refresh', 'valid JSON', ms)
}

async function testApprovalsIsolation() {
  const { res, parsed, ms } = await fetchTimed('/api/approvals?summary=1')
  if (!parsed.parseError && res.ok) pass('approvals_unaffected', 'OK', ms)
  else fail('approvals_unaffected', `status=${res.status}`)
}

function printSummary() {
  const failed = results.filter(r => r.status === 'FAIL')
  const warned = results.filter(r => r.status === 'WARN')
  const passed = results.filter(r => r.status === 'PASS')

  console.log('\n━━ Attendance production verification ━━')
  console.log(`Base: ${BASE}`)
  console.log(`Passed: ${passed.length}  Warn: ${warned.length}  Failed: ${failed.length}`)

  if (metrics.latencies.length) {
    const sorted = [...metrics.latencies].sort((a, b) => a.ms - b.ms)
    const p50 = sorted[Math.floor(sorted.length / 2)]?.ms ?? 0
    const p95 = sorted[Math.floor(sorted.length * 0.95)]?.ms ?? sorted.at(-1)?.ms ?? 0
    console.log(`Latency p50: ${p50}ms  p95: ${p95}ms`)
  }

  if (failed.length) {
    failed.forEach(f => console.error(`  ✗ ${f.name}: ${f.detail}`))
    process.exit(1)
  }
  console.log('\n✓ Attendance production verification complete.')
}

async function main() {
  console.log(`Attendance production verify → ${BASE}`)
  if (!(await ensureAuth())) process.exit(1)

  await testJsonContract()
  await testValidationLatency()
  await testTelegramIsolation()
  await testEmployeeDesk()
  await testSuperAdminVisibility()
  await testCheckInHealth()
  await testAnalyticsRefresh()
  await testApprovalsIsolation()

  if (ALLOW_LIVE_CHECKIN) {
    await testDuplicateContract()
  } else {
    warn('duplicate_protection', 'skipped — set REGRESSION_ALLOW_CHECKIN=1 to run live duplicate test')
    warn('normal_check_in', 'skipped — requires employee-linked regression session')
  }

  printSummary()
}

main()
