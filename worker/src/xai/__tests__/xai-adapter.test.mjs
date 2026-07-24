/**
 * CS13 — xAI Grok Imagine adapter contract tests (node:test, zero new deps).
 * Run: node --test worker/src/xai/__tests__/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildXaiRequest, extractXaiImage, XAI_ALLOWED_MODELS } from '../adapter.mjs'

process.env.XAI_API_KEY = 'test-key'

test('generate request: generations path, no reference images allowed', () => {
  const { path, body } = buildXaiRequest({
    op: 'generate',
    model: 'grok-imagine-image-quality',
    prompt: 'a poster',
    aspectRatio: '3:4',
    resolution: '2k',
  })
  assert.equal(path, '/images/generations')
  assert.equal(body.model, 'grok-imagine-image-quality')
  assert.equal(body.aspect_ratio, '3:4')
  assert.equal(body.resolution, '2k')
  assert.ok(!('image' in body) && !('images' in body))
  assert.throws(() =>
    buildXaiRequest({ op: 'generate', model: 'grok-imagine-image-quality', prompt: 'x', referenceDataUris: ['data:1'] }),
  )
})

test('edit request: single ref uses `image`, multi uses `images` (max 3)', () => {
  const single = buildXaiRequest({
    op: 'edit',
    model: 'grok-imagine-image-quality',
    prompt: 'edit it',
    referenceDataUris: ['data:1'],
  })
  assert.equal(single.path, '/images/edits')
  assert.deepEqual(single.body.image, { url: 'data:1', type: 'image_url' })
  assert.ok(!('images' in single.body))

  const multi = buildXaiRequest({
    op: 'edit',
    model: 'grok-imagine-image-quality',
    prompt: 'combine',
    referenceDataUris: ['data:1', 'data:2', 'data:3'],
  })
  assert.equal(multi.body.images.length, 3)
  assert.deepEqual(multi.body.images[1], { url: 'data:2', type: 'image_url' })
  assert.ok(!('image' in multi.body))

  assert.throws(() =>
    buildXaiRequest({ op: 'edit', model: 'grok-imagine-image-quality', prompt: 'x', referenceDataUris: [] }),
  )
  assert.throws(() =>
    buildXaiRequest({ op: 'edit', model: 'grok-imagine-image-quality', prompt: 'x', referenceDataUris: ['1', '2', '3', '4'] }),
  )
})

test('model allowlist enforced; prompt required', () => {
  assert.throws(() => buildXaiRequest({ op: 'generate', model: 'gpt-image-2', prompt: 'x' }))
  assert.throws(() => buildXaiRequest({ op: 'generate', model: 'grok-imagine-image-quality', prompt: '  ' }))
  assert.deepEqual([...XAI_ALLOWED_MODELS].sort(), ['grok-imagine-image', 'grok-imagine-image-quality'])
})

test('response parsing: b64_json preferred, url fallback, null when empty', () => {
  assert.deepEqual(extractXaiImage({ data: [{ b64_json: 'abc' }] }), { kind: 'b64', value: 'abc' })
  assert.deepEqual(extractXaiImage({ data: [{ url: 'https://x/img.png' }] }), { kind: 'url', value: 'https://x/img.png' })
  assert.equal(extractXaiImage({ data: [] }), null)
  assert.equal(extractXaiImage({}), null)
})
