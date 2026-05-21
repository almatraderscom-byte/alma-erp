#!/usr/bin/env node
/**
 * Pre-deploy regression smoke — validates critical APIs return JSON (not HTML/empty).
 * Auth: REGRESSION_COOKIE or REGRESSION_IDENTIFIER + REGRESSION_PASSWORD (SUPER_ADMIN).
 */
import { loadRegressionEnvFiles } from './regression-env.mjs'
import { resolveRegressionCookie } from './regression-resolve-auth.mjs'

loadRegressionEnvFiles()

const BASE = (process.env.REGRESSION_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
let COOKIE = process.env.REGRESSION_COOKIE || ''
const BUSINESS = process.env.REGRESSION_BUSINESS_ID || 'ALMA_LIFESTYLE'
const CRON_SECRET = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET || ''

/** @type {{ name: string; path: string; method?: string; auth?: boolean; cron?: boolean; body?: object; critical?: boolean }[]} */
const checks = [
  { name: 'health', path: '/api/health', critical: true },
  { name: 'attendance_admin', path: `/api/attendance?business_id=${encodeURIComponent(BUSINESS)}`, auth: true, critical: true },
  { name: 'attendance_me', path: `/api/attendance?business_id=${encodeURIComponent(BUSINESS)}&scope=me`, auth: true, critical: true },
  { name: 'approvals_pending', path: '/api/approvals?status=PENDING&limit=5', auth: true, critical: true },
  { name: 'approvals_integrity', path: '/api/approvals/integrity', auth: true, critical: true },
  { name: 'payroll_wallet_requests', path: `/api/payroll/wallet/requests?business_id=${encodeURIComponent(BUSINESS)}&status=PENDING`, auth: true, critical: true },
  { name: 'business_archive_modules', path: `/api/business-archive/modules?business_id=${encodeURIComponent(BUSINESS)}`, auth: true, critical: true },
  { name: 'business_archive_batches', path: `/api/business-archive/batches?business_id=${encodeURIComponent(BUSINESS)}`, auth: true },
  { name: 'telegram_ops', path: `/api/settings/telegram-ops?business_id=${encodeURIComponent(BUSINESS)}`, auth: true, critical: true },
  { name: 'operational_tasks', path: `/api/operational-tasks?business_id=${encodeURIComponent(BUSINESS)}`, auth: true, critical: true },
  { name: 'operational_tasks_my', path: `/api/operational-tasks/my?business_id=${encodeURIComponent(BUSINESS)}`, auth: true, critical: true },
  { name: 'telegram_cron_dry', path: '/api/cron/telegram-notifications?dry=1', cron: true },
]

const failures = []
const criticalFailures = []
const criticalSkipped = []

function fail(msg, critical) {
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

async function runCheck(check) {
  if (!BASE) {
    fail('REGRESSION_BASE_URL or NEXT_PUBLIC_APP_URL required', true)
    return
  }
  if (check.auth && !COOKIE) {
    console.log(`[SKIP] ${check.name} — set REGRESSION_COOKIE`)
    if (check.critical) criticalSkipped.push(check.name)
    return
  }
  if (check.cron && !CRON_SECRET) {
    console.log(`[SKIP] ${check.name} — set CRON_SECRET`)
    return
  }

  const headers = { Accept: 'application/json' }
  if (check.auth && COOKIE) headers.Cookie = COOKIE
  if (check.cron && CRON_SECRET) headers.Authorization = `Bearer ${CRON_SECRET}`

  let res
  try {
    res = await fetch(`${BASE}${check.path}`, {
      method: check.method || 'GET',
      headers,
      cache: 'no-store',
      body: check.body ? JSON.stringify(check.body) : undefined,
    })
  } catch (e) {
    fail(`${check.name}: network ${e?.message || String(e)}`, check.critical)
    return
  }

  const parsed = await safeParseJson(res)
  if (parsed.parseError) {
    fail(`${check.name}: ${parsed.reason} status=${res.status} snippet=${parsed.snippet || ''}`, check.critical)
    return
  }

  const body = parsed.body
  if (res.status === 401 && check.auth) {
    console.log(`[SKIP] ${check.name} — unauthorized (refresh REGRESSION_COOKIE)`)
    return
  }

  if (!res.ok && body.ok !== false && !body.error?.message && !body.message) {
    fail(`${check.name}: HTTP ${res.status} without structured error`, check.critical)
    return
  }

  if (body.ok === false) {
    const msg = body.error?.message || body.message || body.error
    if (res.status >= 500) fail(`${check.name}: server error — ${msg}`, check.critical)
    else pass(`${check.name}: structured failure (${msg})`)
    return
  }

  pass(`${check.name}: HTTP ${res.status} valid JSON`)
}

async function main() {
  console.log(`Regression smoke → ${BASE || '(no base URL)'}`)
  if (!BASE) process.exit(1)

  if (!COOKIE) {
    const hasCreds =
      (process.env.REGRESSION_IDENTIFIER || process.env.REGRESSION_EMAIL) &&
      process.env.REGRESSION_PASSWORD
    if (hasCreds) {
      try {
        const resolved = await resolveRegressionCookie(BASE)
        COOKIE = resolved.cookie
        console.log(`[auth] Session resolved via ${resolved.source} (value not logged)`)
      } catch (e) {
        console.error(`[FAIL] Could not obtain regression session: ${e?.message || String(e)}`)
        process.exit(1)
      }
    }
  }

  for (const c of checks) await runCheck(c)

  const requireAuth =
    process.env.REQUIRE_REGRESSION_AUTH === '1' || process.env.CI === 'true'
  if (requireAuth && criticalSkipped.length) {
    fail(
      `Critical auth checks skipped (${criticalSkipped.join(', ')}) — set REGRESSION_COOKIE`,
      true,
    )
  }

  if (criticalFailures.length) {
    console.error('\n━━ CRITICAL FAILURES (block deploy) ━━')
    criticalFailures.forEach(f => console.error(`  • ${f}`))
    process.exit(1)
  }
  if (failures.length) {
    console.error('\nRegression smoke had non-critical failures.')
    process.exit(1)
  }
  console.log('\n✓ Regression smoke passed.')
}

main()
