#!/usr/bin/env node
/**
 * Pre-deploy regression smoke — validates critical APIs return JSON (not HTML/empty).
 * Auth: set REGRESSION_BASE_URL and optional REGRESSION_COOKIE (session token cookie).
 *
 * Usage:
 *   REGRESSION_BASE_URL=https://alma-erp-six.vercel.app node scripts/regression-smoke.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

function loadEnvLocal() {
  const path = resolve(root, '.env.local')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[k]) process.env[k] = v
  }
}

loadEnvLocal()

const BASE = (process.env.REGRESSION_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
const COOKIE = process.env.REGRESSION_COOKIE || ''
const BUSINESS = process.env.REGRESSION_BUSINESS_ID || 'ALMA_LIFESTYLE'

const checks = [
  { name: 'health', path: '/api/health', auth: false },
  { name: 'attendance_admin', path: `/api/attendance?business_id=${encodeURIComponent(BUSINESS)}`, auth: true },
  { name: 'attendance_me', path: `/api/attendance?business_id=${encodeURIComponent(BUSINESS)}&scope=me`, auth: true },
  { name: 'approvals_pending', path: '/api/approvals?status=PENDING&limit=5', auth: true },
  { name: 'telegram_queue_stats', path: '/api/cron/telegram-notifications?dry=1', auth: false },
  { name: 'business_archive_modules', path: '/api/business-archive/modules', auth: true },
]

function fail(msg) {
  console.error(`[FAIL] ${msg}`)
  process.exitCode = 1
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

async function runCheck(check) {
  if (!BASE) {
    fail('REGRESSION_BASE_URL or NEXT_PUBLIC_APP_URL required')
    return
  }
  if (check.auth && !COOKIE) {
    console.log(`[SKIP] ${check.name} — set REGRESSION_COOKIE for authenticated routes`)
    return
  }

  const headers = { Accept: 'application/json' }
  if (check.auth && COOKIE) headers.Cookie = COOKIE

  let res
  try {
    res = await fetch(`${BASE}${check.path}`, { headers, cache: 'no-store' })
  } catch (e) {
    fail(`${check.name}: network ${e?.message || String(e)}`)
    return
  }

  const parsed = await safeParseJson(res)
  if (parsed.parseError) {
    fail(`${check.name}: ${parsed.reason} status=${res.status} snippet=${parsed.snippet || ''}`)
    return
  }

  const body = parsed.body
  if (res.status === 401 && check.auth) {
    console.log(`[SKIP] ${check.name} — unauthorized (refresh REGRESSION_COOKIE)`)
    return
  }

  if (!res.ok && body.ok !== false && !body.error) {
    fail(`${check.name}: HTTP ${res.status} without structured error`)
    return
  }

  if (body.ok === false) {
    const msg = body.error?.message || body.message || body.error
    if (res.status >= 500) fail(`${check.name}: server error — ${msg}`)
    else pass(`${check.name}: structured failure (${msg})`)
    return
  }

  pass(`${check.name}: HTTP ${res.status} valid JSON`)
}

async function main() {
  console.log(`Regression smoke → ${BASE || '(no base URL)'}`)
  if (!BASE) {
    fail('missing base URL')
    process.exit(1)
  }
  for (const c of checks) await runCheck(c)
  if (process.exitCode) {
    console.error('\nRegression smoke FAILED — do not deploy.')
    process.exit(1)
  }
  console.log('\nRegression smoke passed (or skipped auth checks).')
}

main()
