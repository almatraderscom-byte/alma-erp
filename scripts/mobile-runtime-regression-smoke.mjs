#!/usr/bin/env node
/**
 * Mobile runtime + PWA + portal safety regression (static contract checks).
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

const approvals = read('src/app/approvals/page.tsx')
const errorTsx = read('src/app/error.tsx')
const pwa = read('src/components/providers/PwaBootstrap.tsx')
const sw = read('public/sw.js')
const mobileLog = read('src/lib/mobile-runtime-log.ts')
const checkinLog = read('src/lib/attendance-checkin-log.ts')
const portal = read('src/app/portal/page.tsx')
const sidebar = read('src/components/layout/Sidebar.tsx')
const normalize = read('src/lib/approvals-response.ts')
const boundary = read('src/components/runtime/SectionErrorBoundary.tsx')
const nextCfg = read('next.config.js')
const faceCheckin = read('src/components/attendance/FaceVerificationCheckIn.tsx')

if (!approvals.includes('normalizeApprovalResponse')) {
  fail('approvals page must normalize API payloads before render')
} else pass('approvals payload normalization')

if (/data\?\.approvals\.length|data\?\.byModule\.length/.test(approvals)) {
  fail('approvals page still uses unsafe optional length access')
} else pass('approvals safe array guards')

if (!errorTsx.includes('logRuntimeMobileCrash')) {
  fail('error.tsx must call logRuntimeMobileCrash')
} else pass('route error mobile crash logging')

if (!mobileLog.includes('attendance.mobile_submit_failed')) {
  fail('mobile-runtime-log missing attendance.mobile_submit_failed')
} else pass('attendance mobile submit log event')

if (!checkinLog.includes('attendance.telegram_event_missing')) {
  fail('attendance-checkin-log missing attendance.telegram_event_missing')
} else pass('telegram missing log event')

if (!pwa.includes('staleBuild') || !pwa.includes('APP_BUILD_ID')) {
  fail('PwaBootstrap missing stale build detection')
} else pass('PWA stale build banner')

if (!sw.includes('alma-erp-shell-v3') || !sw.includes('alma-erp-assets-v3')) {
  fail('service worker cache version must be v3')
} else pass('service worker cache v3')

if (!nextCfg.includes('NEXT_PUBLIC_APP_BUILD_ID')) {
  fail('next.config must expose NEXT_PUBLIC_APP_BUILD_ID')
} else pass('public build id env')

if (!portal.includes('SectionErrorBoundary') || !portal.includes('portal_attendance')) {
  fail('portal must wrap attendance in SectionErrorBoundary')
} else pass('portal attendance section boundary')

if (!sidebar.includes('canApprovals') || !sidebar.includes('isPathAllowedForRole')) {
  fail('mobile nav must hide approvals for disallowed roles')
} else pass('mobile nav approvals guard')

if (!boundary.includes('logRuntimeMobileCrash')) {
  fail('SectionErrorBoundary must log runtime.mobile_crash')
} else pass('section error boundary logging')

if (!normalize.includes('Array.isArray')) {
  fail('normalizeApprovalResponse must coerce arrays')
} else pass('approval response normalizer')

if (!faceCheckin.includes('logAttendanceMobileSubmitFailed')) {
  fail('FaceVerificationCheckIn must log attendance.mobile_submit_failed')
} else pass('check-in mobile submit logging')

if (failures.length) {
  console.error(`\nMobile runtime smoke: ${failures.length} failure(s)`)
  process.exit(1)
}

console.log('\n✓ Mobile runtime smoke passed')
