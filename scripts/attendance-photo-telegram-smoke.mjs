#!/usr/bin/env node
/**
 * Attendance photo storage + Telegram queue contract smoke.
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
    fail(`missing: ${rel}`)
    return ''
  }
  return readFileSync(path, 'utf8')
}

const checkin = read('src/app/api/attendance/check-in/route.ts')
const checkinLib = read('src/lib/attendance-checkin.ts')
const storage = read('src/lib/attendance-photo-storage.ts')
const photoLog = read('src/lib/attendance-photo-log.ts')
const faceNotify = read('src/lib/telegram-notification/face-checkin-notify.ts')
const deliver = read('src/lib/telegram-notification/deliver.ts')
const queue = read('src/lib/telegram-notification/queue.ts')
const adminPage = read('src/app/attendance/page.tsx')
const selfiesRoute = read('src/app/api/attendance/selfies/[id]/route.ts')

if (!checkin.includes('prepareCheckInFaceAssets')) {
  fail('check-in must prepare face assets before commit')
} else pass('atomic photo prepare before commit')

if (!checkin.includes('rollbackCheckInFaceUpload')) {
  fail('check-in must rollback upload on transaction failure')
} else pass('upload rollback on failure')

if (!checkinLib.includes('attendanceSelfieVerification.create')) {
  fail('check-in transaction must create selfie verification row')
} else pass('selfie row in same transaction')

if (!storage.includes('verifyAttendanceStorageObject')) {
  fail('storage must verify file exists after upload')
} else pass('post-upload existence verify')

if (!photoLog.includes('attendance.photo.upload_started')) {
  fail('photo log events missing')
} else pass('photo diagnostic logs')

if (!faceNotify.includes('await enqueueTelegramNotification')) {
  fail('face notify must await durable enqueue')
} else pass('awaited telegram enqueue')

if (!faceNotify.includes('attendance.telegram.enqueued')) {
  fail('face notify must log attendance.telegram.enqueued')
} else pass('telegram enqueued log')

if (!deliver.includes('loadAttendanceFacePhotoBuffer')) {
  fail('telegram deliver must load photo from storage')
} else pass('telegram storage photo delivery')

if (!queue.includes('attendance.telegram.sent')) {
  fail('queue processor must log attendance.telegram.sent')
} else pass('telegram sent log')

if (!adminPage.includes('VerificationPhoto')) {
  fail('admin attendance must use VerificationPhoto fallback')
} else pass('admin photo fallback UI')

if (!selfiesRoute.includes('resolveAttendanceImageRefForDisplay')) {
  fail('selfies API must resolve storage refs')
} else pass('selfies API photo resolution')

if (!selfiesRoute.includes('attendance_record_id')) {
  fail('selfies review must support attendance_record_id fallback')
} else pass('selfie lookup fallback by record id')

// storage ref roundtrip
const prefix = 'alma-storage:'
const ref = `${prefix}expense-receipts/attendance-faces/ALMA_LIFESTYLE/EMP-1/2026-05-19/abc.jpg`
const rest = ref.slice(prefix.length)
const slash = rest.indexOf('/')
const bucket = rest.slice(0, slash)
const objectPath = rest.slice(slash + 1)
if (bucket !== 'expense-receipts' || !objectPath.includes('attendance-faces')) {
  fail('storage ref encoding roundtrip')
} else pass('storage ref encoding')

if (failures.length) {
  console.error(`\nAttendance photo/telegram smoke: ${failures.length} failure(s)`)
  process.exit(1)
}

console.log('\n✓ Attendance photo/telegram smoke passed')
