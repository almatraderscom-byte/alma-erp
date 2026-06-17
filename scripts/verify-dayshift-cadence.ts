/**
 * Phase L self-verify — office window + sparse patrol logic (no DB).
 * Usage: npx tsx scripts/verify-dayshift-cadence.ts
 */
import {
  buildDayShiftTickCron,
  isWithinDayShiftWindowUtc,
  parsePatrolIntervalMin,
  DEFAULT_DAYSHIFT_WINDOW_UTC,
} from '../src/agent/lib/dayshift-settings'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

// Night UTC (23:00) — outside 2-16
const night = new Date('2026-06-17T23:00:00.000Z')
assert(!isWithinDayShiftWindowUtc(night, DEFAULT_DAYSHIFT_WINDOW_UTC), '23:00 UTC should be outside window')

// Morning office UTC 03:00 = 09:00 Dhaka — inside
const morning = new Date('2026-06-17T03:00:00.000Z')
assert(isWithinDayShiftWindowUtc(morning, DEFAULT_DAYSHIFT_WINDOW_UTC), '03:00 UTC should be inside window')

// Edge: 16:00 UTC = 22:00 Dhaka — still inside (inclusive end)
const close = new Date('2026-06-17T16:00:00.000Z')
assert(isWithinDayShiftWindowUtc(close, DEFAULT_DAYSHIFT_WINDOW_UTC), '16:00 UTC should be inside window')

// 17:00 UTC = 23:00 Dhaka — outside
const afterClose = new Date('2026-06-17T17:00:00.000Z')
assert(!isWithinDayShiftWindowUtc(afterClose, DEFAULT_DAYSHIFT_WINDOW_UTC), '17:00 UTC should be outside window')

assert(buildDayShiftTickCron('2-16') === '*/12 2-16 * * *', 'tick cron build')
assert(parsePatrolIntervalMin('60') === 60, 'patrol interval parse')
assert(parsePatrolIntervalMin('5') === 60, 'patrol interval min clamp')

// Custom window
assert(buildDayShiftTickCron('3-15') === '*/12 3-15 * * *', 'custom window cron')

console.log('PASS — dayshift cadence logic verified')
console.log('  night skip: 23:00 UTC outside')
console.log('  office: 03:00 UTC inside')
console.log('  default cron:', buildDayShiftTickCron())
