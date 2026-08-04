import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertGenericImageModel,
  genericProviderForModel,
  loadRequiredReferenceParts,
  makeReferenceReceipt,
  requiredReferencePaths,
} from '../reference-contract.mjs'

const payload = {
  referenceImageId: 'models/person.jpg',
  secondReferenceImageId: 'products/product.jpg',
  referenceContract: {
    bindings: [
      { role: 'person', path: 'models/person.jpg', source: 'saved_model', required: true },
      { role: 'product', path: 'products/product.jpg', source: 'uploaded', required: true },
    ],
  },
}

test('generic model snapshot is allowlisted and truthfully attributed', () => {
  assert.equal(assertGenericImageModel('gpt-image-2'), 'gpt-image-2')
  assert.equal(genericProviderForModel('gpt-image-2'), 'openai')
  assert.equal(genericProviderForModel('seedream-5.0-pro'), 'fal')
  assert.equal(genericProviderForModel('gemini-3-pro-image'), 'gemini')
  assert.throws(() => assertGenericImageModel('injected-model'), /not allowlisted/)
})

test('contract fixes reference order and produces an auditable receipt', () => {
  assert.deepEqual(requiredReferencePaths(payload), ['models/person.jpg', 'products/product.jpg'])
  assert.deepEqual(makeReferenceReceipt(payload, 2), {
    version: 1,
    expectedCount: 2,
    sentCount: 2,
    roles: ['person', 'product'],
    sources: ['saved_model', 'uploaded'],
    allRequiredSent: true,
  })
})

test('a missing selected reference fails before a provider request', async () => {
  await assert.rejects(
    loadRequiredReferenceParts(requiredReferencePaths(payload), async (path) =>
      path.includes('product') ? null : { inlineData: { data: 'person' } }),
    /required reference unavailable: products\/product.jpg/,
  )
  assert.throws(() => makeReferenceReceipt(payload, 1), /expected 2, sent 1/)
})

test('stale or reordered legacy fields cannot contradict the immutable contract', () => {
  assert.throws(() => requiredReferencePaths({
    ...payload,
    referenceImageId: 'products/product.jpg',
    secondReferenceImageId: 'models/person.jpg',
  }), /order mismatch/)
})

test('final production repair transports the ordered try-on, person and product references', () => {
  const three = {
    referenceImageId: 'generated/tryon.png',
    referenceImageIds: ['generated/tryon.png', 'models/person.jpg', 'products/product.jpg'],
    referenceContract: {
      bindings: [
        { role: 'source', path: 'generated/tryon.png', source: 'derived', required: true },
        { role: 'person', path: 'models/person.jpg', source: 'saved_model', required: true },
        { role: 'product', path: 'products/product.jpg', source: 'uploaded', required: true },
      ],
    },
  }
  assert.deepEqual(requiredReferencePaths(three), three.referenceImageIds)
  assert.equal(makeReferenceReceipt(three, 3).allRequiredSent, true)
})
