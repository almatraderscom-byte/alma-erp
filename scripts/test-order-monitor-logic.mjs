/**
 * Unit check: order issue detection helpers (no GAS).
 */
import assert from 'node:assert/strict'

const MS_PER_DAY = 86_400_000

function detectStuck(pendingOrders, now = Date.now()) {
  return pendingOrders.filter((order) => {
    const placed = new Date(order.placedAt).getTime()
    return Number.isFinite(placed) && placed > 0 && now - placed > 3 * MS_PER_DAY
  })
}

const now = Date.parse('2026-06-14T12:00:00+06:00')
const stuck = detectStuck(
  [
    { placedAt: '2026-06-10T00:00:00.000Z', id: 'A1' },
    { placedAt: '2026-06-13T00:00:00.000Z', id: 'A2' },
  ],
  now,
)

assert.equal(stuck.length, 1)
assert.equal(stuck[0].id, 'A1')

console.log('PASS: stuck pending filter')
