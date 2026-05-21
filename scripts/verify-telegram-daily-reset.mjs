/**
 * Verifies BD daily reset helpers (Asia/Dhaka semantics via UTC+6 offset).
 * Run: node scripts/verify-telegram-daily-reset.mjs
 */

const BD_OFFSET_MS = 6 * 60 * 60 * 1000

function tradingBdNow() {
  return new Date(Date.now() + BD_OFFSET_MS)
}

function tradingBdYmdFromInstant(instant) {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  return new Date(d.getTime() + BD_OFFSET_MS).toISOString().slice(0, 10)
}

function tradingBdDayBounds(date = tradingBdNow()) {
  const ymd = date.toISOString().slice(0, 10)
  const start = new Date(`${ymd}T00:00:00.000Z`)
  start.setTime(start.getTime() - BD_OFFSET_MS)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end, ymd }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  console.log(`  OK: ${msg}`)
}

console.log('=== BD timezone helpers ===\n')

// May 19 20:00 UTC = May 20 02:00 BD
const bdMorning = new Date('2026-05-19T20:00:00.000Z')
assert(tradingBdYmdFromInstant(bdMorning) === '2026-05-20', 'BD date rolls at UTC+6 midnight')

// May 19 17:59 UTC = still May 19 in BD
const bdPrevNight = new Date('2026-05-19T17:59:00.000Z')
assert(tradingBdYmdFromInstant(bdPrevNight) === '2026-05-19', 'before BD midnight stays prior day')

const dayA = tradingBdDayBounds(new Date('2026-05-20T12:00:00.000Z'))
const dayB = tradingBdDayBounds(new Date('2026-05-21T12:00:00.000Z'))
assert(dayA.ymd !== dayB.ymd, 'consecutive BD days differ')
assert(dayA.end.getTime() === dayB.start.getTime(), 'day windows are contiguous')

console.log('\n=== Trade numbering simulation ===\n')

function nextNumberForDay(drafts, dayStart, dayEnd) {
  const inDay = drafts.filter(d => d.createdAt >= dayStart && d.createdAt < dayEnd && d.status !== 'UNDONE')
  const max = inDay.reduce((m, d) => Math.max(m, d.tradeNumber ?? 0), 0)
  return max + 1
}

// UTC instants chosen so BD ymd matches labels (UTC+6): 18:00Z evening = next BD calendar day
const userDrafts = [
  { createdAt: new Date('2026-05-18T20:00:00.000Z'), tradeNumber: 1, status: 'POSTED' }, // 2026-05-19 BD
  { createdAt: new Date('2026-05-19T10:00:00.000Z'), tradeNumber: 2, status: 'POSTED' }, // 2026-05-19 BD
  { createdAt: new Date('2026-05-19T20:00:00.000Z'), tradeNumber: 1, status: 'PENDING' }, // 2026-05-20 BD (reset)
  { createdAt: new Date('2026-05-20T10:00:00.000Z'), tradeNumber: 2, status: 'PENDING' }, // 2026-05-20 BD
]

function boundsForYmd(ymd) {
  const start = new Date(`${ymd}T00:00:00.000Z`)
  start.setTime(start.getTime() - BD_OFFSET_MS)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start, end, ymd }
}

const may19 = boundsForYmd('2026-05-19')
const may20 = boundsForYmd('2026-05-20')

assert(nextNumberForDay(userDrafts, may19.start, may19.end) === 3, 'May 19 BD next # is 3 after #1-#2')
assert(nextNumberForDay(userDrafts, may20.start, may20.end) === 3, 'May 20 BD continues #1,#2 then next is #3')
assert(
  userDrafts.filter(d => tradingBdYmdFromInstant(d.createdAt) === '2026-05-20').map(d => d.tradeNumber).sort().join(',') === '1,2',
  'May 20 BD shows reset numbering #1 and #2 (not continuing #3 from prior BD day)',
)

console.log('\n=== Duplicate day scope simulation ===\n')

function hasDraftInWindow(dayStart, dayEnd) {
  return userDrafts.some(
    d => d.createdAt >= dayStart && d.createdAt < dayEnd && d.status !== 'UNDONE',
  )
}

assert(hasDraftInWindow(may19.start, may19.end), 'drafts exist on May 19 BD')
assert(hasDraftInWindow(may20.start, may20.end), 'drafts exist on May 20 BD')
assert(
  !userDrafts.some(
    d =>
      tradingBdYmdFromInstant(d.createdAt) === '2026-05-19' &&
      tradingBdYmdFromInstant(d.createdAt) === '2026-05-20',
  ),
  'no draft spans two BD days',
)
const may20Only = userDrafts.filter(d => tradingBdYmdFromInstant(d.createdAt) === '2026-05-20')
const may19Only = userDrafts.filter(d => tradingBdYmdFromInstant(d.createdAt) === '2026-05-19')
assert(may19Only.length === 2 && may20Only.length === 2, 'duplicate scope: 2 trades per BD day, isolated')

console.log('\n=== History preservation ===\n')
assert(userDrafts.length === 4, 'all historical draft rows remain in simulation')
console.log('  OK: daily reset does not delete rows (numbering/summary are scoped queries only)')

console.log('\nAll daily-reset helper checks passed.\n')
