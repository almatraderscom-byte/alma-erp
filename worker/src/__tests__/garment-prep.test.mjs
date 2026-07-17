/**
 * Unit tests for the pure connected-component labeler used by supplier-photo
 * garment prep (worker/src/garment-prep.mjs).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectedComponents } from '../garment-prep.mjs'

function maskFromRows(rows) {
  const height = rows.length
  const width = rows[0].length
  const mask = new Uint8Array(width * height)
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) mask[y * width + x] = row[x] === '#' ? 1 : 0
  })
  return { mask, width, height }
}

test('two separated people = two components, sorted by caller not labeler', () => {
  const { mask, width, height } = maskFromRows([
    '##....##',
    '##....##',
    '##....##',
    '......##',
  ])
  const comps = connectedComponents(mask, width, height)
  assert.equal(comps.length, 2)
  const tall = comps.find((c) => c.height === 4)
  const short = comps.find((c) => c.height === 3)
  assert.ok(tall && short)
  assert.equal(tall.area, 8)
  assert.equal(short.area, 6)
})

test('touching people merge into ONE component (olive-photo limitation)', () => {
  const { mask, width, height } = maskFromRows([
    '##....##',
    '########', // father's hand on son's shoulder
    '##....##',
  ])
  const comps = connectedComponents(mask, width, height)
  assert.equal(comps.length, 1)
  assert.equal(comps[0].width, width)
})

test('empty mask yields no components', () => {
  const { mask, width, height } = maskFromRows(['....', '....'])
  assert.equal(connectedComponents(mask, width, height).length, 0)
})

test('diagonal-only contact does NOT merge (4-connectivity)', () => {
  const { mask, width, height } = maskFromRows([
    '#.',
    '.#',
  ])
  assert.equal(connectedComponents(mask, width, height).length, 2)
})
