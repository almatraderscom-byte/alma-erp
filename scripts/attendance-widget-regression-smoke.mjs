#!/usr/bin/env node
/**
 * Attendance widget safety — blocks deploy when portal attendance render guards regress.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function fail(msg) {
  console.error(`[FAIL] ${msg}`)
  failures.push(msg)
}

function pass(msg) {
  console.log(`[OK] ${msg}`)
}

function read(rel) {
  const path = resolve(root, rel)
  if (!existsSync(path)) {
    fail(`missing file: ${rel}`)
    return ''
  }
  return readFileSync(path, 'utf8')
}

/** Minimal mirror of attendance-portal-normalize for runtime assertions */
function asStringArray(value) {
  if (Array.isArray(value)) return value.filter(x => typeof x === 'string')
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

function normalizeSummary(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    presentDays: n(s.presentDays),
    lateCount: n(s.lateCount),
    totalPenalties: n(s.totalPenalties),
    waivedPenalties: n(s.waivedPenalties),
    averageWorkMinutes: n(s.averageWorkMinutes),
  }
}

function unwrapAttendanceBody(raw) {
  let body = raw
  for (let i = 0; i < 3; i++) {
    if (!body || typeof body !== 'object') return {}
    if (body.ok === true && body.data != null && typeof body.data === 'object') {
      body = body.data
      continue
    }
    break
  }
  return body && typeof body === 'object' ? body : {}
}

function normalizePayload(raw) {
  const body = unwrapAttendanceBody(raw)
  return {
    today: body.today ?? null,
    summary: normalizeSummary(body.summary),
    records: Array.isArray(body.records) ? body.records : [],
    waivers: Array.isArray(body.waivers) ? body.waivers : [],
  }
}

function assertRenderSafe(payload) {
  const summary = payload.summary ?? normalizeSummary(null)
  void `${summary.presentDays} days`
  const today = payload.today
  if (today) {
    asStringArray(today.suspiciousReasons).map(r => r.toLowerCase())
  }
}

// --- unit cases ---
try {
  assertRenderSafe(normalizePayload({ ok: true, data: { today: { suspiciousReasons: null }, summary: undefined } }))
  pass('null verification reasons + missing summary')
} catch (e) {
  fail(`null verification reasons: ${e.message}`)
}

try {
  assertRenderSafe(normalizePayload({ today: { suspiciousReasons: 'NEW_DEVICE' }, summary: null }))
  pass('string suspiciousReasons coerced')
} catch (e) {
  fail(`string suspiciousReasons: ${e.message}`)
}

try {
  assertRenderSafe(normalizePayload({ ok: true, data: { ok: true, data: { records: [], waivers: [] } } }))
  pass('double-wrapped envelope')
} catch (e) {
  fail(`double-wrapped: ${e.message}`)
}

try {
  assertRenderSafe(normalizePayload({ records: null, waivers: undefined, today: null }))
  pass('empty attendance data')
} catch (e) {
  fail(`empty data: ${e.message}`)
}

try {
  const stale = { ok: true, data: { today: { id: 'x', penaltyAmount: '12' }, summary: { presentDays: '3' } } }
  assertRenderSafe(normalizePayload(stale))
  pass('stale partial cached payload')
} catch (e) {
  fail(`stale payload: ${e.message}`)
}

// --- static contract ---
const portal = read('src/app/portal/page.tsx')
const normalize = read('src/lib/attendance-portal-normalize.ts')
const hook = read('src/hooks/useMyAttendance.ts')
const client = read('src/lib/attendance-client.ts')

if (!normalize.includes('ATTENDANCE_PAYLOAD_VERSION')) {
  fail('attendance payload versioning missing')
} else pass('attendance payload versioning')

if (!normalize.includes('normalizeMyAttendancePayload')) {
  fail('normalizeMyAttendancePayload missing')
} else pass('attendance normalizer')

if (/attendance\.summary\.presentDays|today\.suspiciousReasons\.map/.test(portal)) {
  fail('portal still has unsafe raw attendance property access')
} else pass('portal safe attendance property access')

if (!portal.includes('normalizeMyAttendancePayload') || !portal.includes('asStringArray')) {
  fail('portal AttendanceCard must normalize before render')
} else pass('portal normalizes attendance at render')

if (!hook.includes('clearAttendancePortalCache') || !hook.includes('writeAttendancePortalCache')) {
  fail('useMyAttendance must manage versioned attendance cache')
} else pass('attendance cache versioning in hook')

if (!client.includes('normalizeMyAttendancePayload')) {
  fail('attendance-client must normalize fetch results')
} else pass('attendance-client normalization')

if (!read('src/lib/attendance-checkin.ts').includes('queueAttendanceCheckInSideEffects')) {
  fail('check-in telegram must stay non-blocking')
} else pass('telegram enqueue non-blocking')

if (failures.length) {
  console.error(`\nAttendance widget smoke: ${failures.length} failure(s)`)
  process.exit(1)
}

console.log('\n✓ Attendance widget smoke passed')
