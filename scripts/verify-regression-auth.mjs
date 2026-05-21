#!/usr/bin/env node
/**
 * Quick check: can we resolve a production SUPER_ADMIN session? (never logs cookie)
 */
import { loadRegressionEnvFiles } from './regression-env.mjs'
import { resolveRegressionCookie } from './regression-resolve-auth.mjs'

loadRegressionEnvFiles()

const base = (process.env.REGRESSION_BASE_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')

async function main() {
  const hasDirect = Boolean(process.env.REGRESSION_COOKIE)
  const hasCreds =
    (process.env.REGRESSION_IDENTIFIER || process.env.REGRESSION_EMAIL) &&
    process.env.REGRESSION_PASSWORD

  if (!hasDirect && !hasCreds) {
    console.error('[FAIL] Set REGRESSION_COOKIE or REGRESSION_IDENTIFIER+REGRESSION_PASSWORD in .env.regression.local')
    process.exit(1)
  }

  const { cookie, source } = await resolveRegressionCookie(base)
  if (!cookie) {
    console.error('[FAIL] Empty session cookie')
    process.exit(1)
  }

  const res = await fetch(`${base}/api/approvals?summary=1`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
    cache: 'no-store',
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    console.error('[FAIL] Approvals summary returned non-JSON', res.status)
    process.exit(1)
  }

  if (res.status === 401) {
    console.error('[FAIL] Session rejected (401) — refresh REGRESSION_COOKIE or credentials')
    process.exit(1)
  }

  console.log(`[OK] Auth via ${source} — approvals summary HTTP ${res.status}`)
  if (body.totalPending != null) console.log(`[OK] totalPending=${body.totalPending}`)
}

main().catch(e => {
  console.error('[FAIL]', e?.message || String(e))
  process.exit(1)
})
