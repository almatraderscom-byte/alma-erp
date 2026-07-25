import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateFashnCredits, extractFashnOutputs, validateFashnReferenceContract } from '../process.mjs'

test('direct FASHN Product→Model carries product + selected person as face_reference', () => {
  const inputs = {
    product_image: 'products/p.jpg',
    face_reference: 'models/m.jpg',
    face_reference_mode: 'match_reference',
  }
  assert.doesNotThrow(() => validateFashnReferenceContract(inputs, {
    bindings: [
      { role: 'product', path: 'products/p.jpg', required: true },
      { role: 'person', path: 'models/m.jpg', required: true },
    ],
  }))
})

test('direct FASHN fails before provider execution if a selected reference is absent', () => {
  assert.throws(() => validateFashnReferenceContract(
    { product_image: 'products/p.jpg' },
    {
      bindings: [
        { role: 'product', path: 'products/p.jpg', required: true },
        { role: 'person', path: 'models/m.jpg', required: true },
      ],
    },
  ), /expected 2, queued 1/)
})

test('direct FASHN cost credits include quality/resolution and face-reference surcharge', () => {
  assert.equal(calculateFashnCredits(
    { resolution: '2k', generationMode: 'balanced' },
    { product_image: 'p.jpg', face_reference: 'm.jpg' },
  ), 6)
  assert.equal(calculateFashnCredits(
    { resolution: '1k', generationMode: 'fast' },
    { product_image: 'p.jpg' },
  ), 1)
})

test('normalizes FASHN array and Face→Model object output shapes', () => {
  assert.deepEqual(extractFashnOutputs(['https://cdn/one.png']), ['https://cdn/one.png'])
  assert.deepEqual(extractFashnOutputs({ images: ['https://cdn/face.png'] }), ['https://cdn/face.png'])
  assert.deepEqual(extractFashnOutputs(null), [])
})
