#!/usr/bin/env node
/** GET-only production check for penalty appeal result SMS configuration. */
const BASE = (process.env.REGRESSION_BASE_URL || 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
const BUSINESS = process.env.REGRESSION_BUSINESS_ID || 'ALMA_LIFESTYLE'
const cookie = process.env.REGRESSION_COOKIE || ''

if (!cookie) {
  console.error('[FAIL] sms_smoke — authenticated regression cookie is required')
  process.exit(1)
}

const response = await fetch(`${BASE}/api/sms?business_id=${encodeURIComponent(BUSINESS)}`, {
  headers: { Accept: 'application/json', Cookie: cookie },
  cache: 'no-store',
})
const body = await response.json().catch(() => ({}))
const enabledTypes = Array.isArray(body?.setting?.enabledTypes) ? body.setting.enabledTypes : []
const catalog = Array.isArray(body?.catalog) ? body.catalog : []

if (!response.ok) {
  console.error(`[FAIL] sms_smoke — HTTP ${response.status}`)
  process.exit(1)
}
if (body?.setting?.enabled !== true) {
  console.error('[FAIL] sms_smoke — SMS is disabled for the business')
  process.exit(1)
}
if (!catalog.some((item) => item?.type === 'PENALTY_APPEAL_REVIEWED')) {
  console.error('[FAIL] sms_smoke — penalty result type is missing from the catalog')
  process.exit(1)
}
if (!enabledTypes.includes('PENALTY_APPEAL_REVIEWED')) {
  console.error('[FAIL] sms_smoke — penalty result SMS is not enabled')
  process.exit(1)
}

console.log('[PASS] penalty_result_sms — provider setting enabled, type catalogued and active')
