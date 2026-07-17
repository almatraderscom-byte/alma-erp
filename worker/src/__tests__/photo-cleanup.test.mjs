/**
 * Unit tests for the pure plate-cleanup functions (worker/src/photo-cleanup.mjs).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectDarkPlates,
  smearFillMask,
  fillMaskHoles,
  largestComponentMask,
} from '../photo-cleanup.mjs'

/** Build an RGB image from rows of '#' (dark 30) '.' (bright 200). */
function rgbFromRows(rows) {
  const height = rows.length
  const width = rows[0].length
  const rgb = new Uint8Array(width * height * 3)
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const v = row[x] === '#' ? 30 : 200
      const i = (y * width + x) * 3
      rgb[i] = v; rgb[i + 1] = v; rgb[i + 2] = v
    }
  })
  return { rgb, width, height }
}

test('detects a solid dark rectangle and returns its pixel mask', () => {
  const rows = []
  for (let y = 0; y < 20; y++) {
    // 6x4 plate at (2,2)
    rows.push(
      Array.from({ length: 20 }, (_, x) => (x >= 2 && x < 8 && y >= 2 && y < 6 ? '#' : '.')).join(''),
    )
  }
  const { rgb, width, height } = rgbFromRows(rows)
  const { boxes, fillMask } = detectDarkPlates(rgb, width, height, null)
  assert.equal(boxes.length, 1)
  assert.deepEqual(boxes[0], { x: 2, y: 2, width: 6, height: 4 })
  assert.equal(fillMask.reduce((a, b) => a + b, 0), 24)
})

test('rejects a component that is mostly ON the person', () => {
  const rows = []
  for (let y = 0; y < 20; y++) {
    rows.push(
      Array.from({ length: 20 }, (_, x) => (x >= 2 && x < 8 && y >= 2 && y < 6 ? '#' : '.')).join(''),
    )
  }
  const { rgb, width, height } = rgbFromRows(rows)
  const person = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < 10; x++) person[y * width + x] = 1
  const { boxes } = detectDarkPlates(rgb, width, height, person)
  assert.equal(boxes.length, 0)
})

test('rejects thin scraggly components (low fill ratio)', () => {
  const rows = []
  for (let y = 0; y < 20; y++) {
    // diagonal line — bbox big, area small
    rows.push(Array.from({ length: 20 }, (_, x) => (x === y ? '#' : '.')).join(''))
  }
  const { rgb, width, height } = rgbFromRows(rows)
  const { boxes } = detectDarkPlates(rgb, width, height, null)
  assert.equal(boxes.length, 0)
})

test('fillMaskHoles captures white text glyphs inside a dark plate', () => {
  const { mask, width, height } = (() => {
    const rows = [
      '........',
      '.######.',
      '.#.##.#.', // holes = "text"
      '.######.',
      '........',
    ]
    const h = rows.length
    const w = rows[0].length
    const m = new Uint8Array(w * h)
    rows.forEach((row, y) => { for (let x = 0; x < w; x++) m[y * w + x] = row[x] === '#' ? 1 : 0 })
    return { mask: m, width: w, height: h }
  })()
  const filled = fillMaskHoles(mask, width, height)
  // the two interior holes are now part of the mask; exterior stays 0
  assert.equal(filled[2 * width + 2], 1)
  assert.equal(filled[2 * width + 5], 1)
  assert.equal(filled[0], 0)
})

test('smearFillMask lerps masked pixels from clean flanks, skips person', () => {
  const { rgb, width, height } = rgbFromRows(['........'])
  const mask = new Uint8Array(width)
  mask[3] = 1; mask[4] = 1
  // flank values: left=10, right=90
  rgb[2 * 3] = 10; rgb[2 * 3 + 1] = 10; rgb[2 * 3 + 2] = 10
  rgb[5 * 3] = 90; rgb[5 * 3 + 1] = 90; rgb[5 * 3 + 2] = 90
  const person = new Uint8Array(width)
  person[4] = 1
  const before4 = rgb[4 * 3]
  smearFillMask(rgb, width, height, mask, person)
  assert.notEqual(rgb[3 * 3], 30) // filled
  assert.ok(rgb[3 * 3] > 10 && rgb[3 * 3] < 90)
  assert.equal(rgb[4 * 3], before4) // person untouched
})

test('largestComponentMask keeps only the biggest blob', () => {
  const rows = ['##..#', '##..#', '.....']
  const h = rows.length
  const w = rows[0].length
  const m = new Uint8Array(w * h)
  rows.forEach((row, y) => { for (let x = 0; x < w; x++) m[y * w + x] = row[x] === '#' ? 1 : 0 })
  const out = largestComponentMask(m, w, h)
  assert.equal(out[0], 1) // big blob kept
  assert.equal(out[4], 0) // small blob dropped
  assert.equal(out.reduce((a, b) => a + b, 0), 4)
})
