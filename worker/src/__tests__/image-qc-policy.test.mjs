import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveQcLevel, productionCoreAxesPass } from '../image-qc.mjs'

test('signed production policy cannot be disabled by mutable global QC level', () => {
  assert.equal(effectiveQcLevel('off', 'production'), 'strict')
  assert.equal(effectiveQcLevel('normal', 'production'), 'strict')
  assert.equal(effectiveQcLevel('off', 'preview'), 'off')
})

test('production core axes all require four', () => {
  assert.equal(productionCoreAxesPass({ garment_fidelity: 4, model_preserved: 4, anatomy: 4 }), true)
  assert.equal(productionCoreAxesPass({ garment_fidelity: 5, model_preserved: 5, anatomy: 3 }), false)
})
