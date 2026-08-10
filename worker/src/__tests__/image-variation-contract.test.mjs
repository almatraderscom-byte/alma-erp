import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeVariationCount,
  partialVariationWarning,
  variationPrompt,
} from '../image/variation-contract.mjs'

test('variation count is bounded to one approval batch', () => {
  assert.equal(normalizeVariationCount(undefined), 1)
  assert.equal(normalizeVariationCount(3), 3)
  assert.equal(normalizeVariationCount(99), 4)
  assert.equal(normalizeVariationCount(-2), 1)
})

test('later images are explicitly distinct and never collages', () => {
  assert.equal(variationPrompt('ALMA poster', 1, 3), 'ALMA poster')
  const prompt = variationPrompt('ALMA poster', 2, 3)
  assert.match(prompt, /VARIATION 2 OF 3/)
  assert.match(prompt, /Do not make a collage/)
})

test('partial variation delivery keeps completed images owner-visible', () => {
  assert.equal(
    partialVariationWarning(1, 3, 2),
    '1 of 3 images completed; variation 2 failed. Completed images were preserved — retry for the remaining variations.',
  )
})
