/** Tests for the merged-person erosion split (worker/src/garment-prep.mjs). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { erodeMask, splitMergedPersons } from '../garment-prep.mjs'

function maskFromRows(rows) {
  const height = rows.length
  const width = rows[0].length
  const mask = new Uint8Array(width * height)
  rows.forEach((row, y) => { for (let x = 0; x < width; x++) mask[y * width + x] = row[x] === '#' ? 1 : 0 })
  return { mask, width, height }
}

test('erodeMask shrinks a blob by its 1px border', () => {
  const { mask, width, height } = maskFromRows(['#####', '#####', '#####'])
  const out = erodeMask(mask, width, height)
  assert.equal(out.reduce((a, b) => a + b, 0), 3) // only the middle row's inner 3
})

test('two blobs joined by a thin bridge split into 2 labels covering the original', () => {
  // two 6x8 solid blocks joined by a 1px-tall bridge (a hand on a shoulder)
  const rows = []
  for (let y = 0; y < 12; y++) {
    let row = ''
    for (let x = 0; x < 20; x++) {
      const inA = x >= 1 && x < 7 && y >= 2 && y < 11
      const inB = x >= 13 && x < 19 && y >= 2 && y < 11
      const inBridge = y === 4 && x >= 7 && x < 13
      row += inA || inB || inBridge ? '#' : '.'
    }
    rows.push(row)
  }
  const { mask, width, height } = maskFromRows(rows)
  const split = splitMergedPersons(mask, width, height, { maxIter: 4, minAreaFrac: 0.05 })
  assert.ok(split, 'split found')
  assert.equal(split.count, 2)
  // every original mask pixel got a label; left/right blobs differ
  let unlabeled = 0
  for (let i = 0; i < mask.length; i++) if (mask[i] && !split.labels[i]) unlabeled++
  assert.equal(unlabeled, 0)
  const li = (5 * width + 3)
  const ri = (5 * width + 16)
  assert.notEqual(split.labels[li], 0)
  assert.notEqual(split.labels[ri], 0)
  assert.notEqual(split.labels[li], split.labels[ri])
})

test('a genuinely single person returns null (no false split)', () => {
  const rows = []
  for (let y = 0; y < 16; y++) {
    let row = ''
    for (let x = 0; x < 10; x++) row += x >= 2 && x < 8 && y >= 1 && y < 15 ? '#' : '.'
    rows.push(row)
  }
  const { mask, width, height } = maskFromRows(rows)
  assert.equal(splitMergedPersons(mask, width, height, { maxIter: 4, minAreaFrac: 0.05 }), null)
})
