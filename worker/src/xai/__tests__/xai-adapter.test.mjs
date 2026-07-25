/**
 * CS13 — xAI Grok Imagine adapter contract tests (node:test, zero new deps).
 * Run: node --test worker/src/xai/__tests__/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  buildXaiRequest,
  extractXaiImage,
  saveXaiImage,
  validateXaiReferenceContract,
  XAI_ALLOWED_MODELS,
} from '../adapter.mjs'

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

test('unsupported 4K and 4:5 requests fail at the request builder', () => {
  assert.throws(
    () => buildXaiRequest({
      op: 'generate',
      model: 'grok-imagine-image-quality',
      prompt: 'x',
      aspectRatio: '16:9',
      resolution: '4k',
    }),
    /does not support 4K/,
  )
  assert.throws(
    () => buildXaiRequest({
      op: 'generate',
      model: 'grok-imagine-image-quality',
      prompt: 'x',
      aspectRatio: '4:5',
      resolution: '2k',
    }),
    /does not support aspect ratio 4:5/,
  )
})

test('response parsing: b64_json preferred, url fallback, null when empty', () => {
  assert.deepEqual(extractXaiImage({ data: [{ b64_json: 'abc' }] }), { kind: 'b64', value: 'abc' })
  assert.deepEqual(extractXaiImage({ data: [{ url: 'https://x/img.png' }] }), { kind: 'url', value: 'https://x/img.png' })
  assert.equal(extractXaiImage({ data: [] }), null)
  assert.equal(extractXaiImage({}), null)
})

test('selected Product→Model product/person order is immutable before transport', () => {
  const refs = ['products/p.jpg', 'models/m.jpg']
  const contract = {
    bindings: [
      { role: 'product', path: refs[0], required: true },
      { role: 'person', path: refs[1], required: true },
    ],
  }
  assert.deepEqual(validateXaiReferenceContract(refs, contract), contract.bindings)
  assert.throws(
    () => validateXaiReferenceContract([...refs].reverse(), contract),
    /order mismatch at 1/,
  )
  assert.throws(
    () => validateXaiReferenceContract([refs[0]], contract),
    /expected 2, queued 1/,
  )
})

function fakeSupabase() {
  const uploaded = new Map()
  return {
    uploaded,
    storage: {
      from(bucket) {
        assert.equal(bucket, 'agent-files')
        return {
          upload: async (path, bytes, options) => {
            uploaded.set(path, { bytes: Buffer.from(bytes), options })
            return { error: null }
          },
        }
      },
    },
  }
}

test('xAI b64 response is sniffed as JPEG and original bytes are preserved', async () => {
  const bytes = await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  }).jpeg().toBuffer()
  const supabase = fakeSupabase()
  const artifact = await saveXaiImage(
    supabase,
    { kind: 'b64', value: bytes.toString('base64') },
    'pa-xai-b64',
    {
      model: 'grok-imagine-image-quality',
      requestedTier: '1k',
      requestedAspectRatio: '1:1',
      validationContract: { mode: 'tier-long-edge', tier: '1k' },
    },
  )
  assert.equal(artifact.storagePath, 'generated/studio-pa-xai-b64.jpg')
  assert.equal(artifact.format, 'jpeg')
  assert.equal(artifact.mimeType, 'image/jpeg')
  assert.equal(artifact.validation, 'verified')
  assert.deepEqual(supabase.uploaded.get(artifact.storagePath).bytes, bytes)
})

test('xAI temporary URL response is sniffed as WebP despite a PNG header', async () => {
  const bytes = await sharp({
    create: {
      width: 2048,
      height: 1152,
      channels: 3,
      background: { r: 4, g: 5, b: 6 },
    },
  }).webp().toBuffer()
  const supabase = fakeSupabase()
  const artifact = await saveXaiImage(
    supabase,
    { kind: 'url', value: 'https://x.invalid/image.png' },
    'pa-xai-url',
    {
      model: 'grok-imagine-image-quality',
      requestedTier: '2k',
      requestedAspectRatio: '16:9',
      validationContract: { mode: 'tier-long-edge', tier: '2k' },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => bytes,
      }),
    },
  )
  assert.equal(artifact.storagePath, 'generated/studio-pa-xai-url.webp')
  assert.equal(artifact.format, 'webp')
  assert.equal(artifact.validation, 'verified')
  assert.deepEqual(supabase.uploaded.get(artifact.storagePath).bytes, bytes)
})
