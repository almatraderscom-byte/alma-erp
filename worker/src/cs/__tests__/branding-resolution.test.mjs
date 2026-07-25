import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { postProcessImage } from '../branding.mjs'

function fakeSupabase(sourcePath, sourceBytes) {
  const uploaded = new Map([[sourcePath, {
    bytes: sourceBytes,
    options: { contentType: 'image/png' },
  }]])
  return {
    uploaded,
    storage: {
      from(bucket) {
        assert.equal(bucket, 'agent-files')
        return {
          download: async (path) => {
            const stored = uploaded.get(path)
            if (!stored) return { data: null, error: new Error('missing') }
            return {
              data: new Blob([stored.bytes], { type: stored.options.contentType }),
              error: null,
            }
          },
          upload: async (path, bytes, options) => {
            uploaded.set(path, { bytes: Buffer.from(bytes), options })
            return { error: null }
          },
        }
      },
    },
  }
}

test('post-processing reports independent original and 480px thumbnail descriptors', async () => {
  const sourcePath = 'generated/source.png'
  const sourceBytes = await sharp({
    create: {
      width: 2048,
      height: 1024,
      channels: 3,
      background: { r: 11, g: 22, b: 33 },
    },
  }).png().toBuffer()
  const supabase = fakeSupabase(sourcePath, sourceBytes)

  const result = await postProcessImage(supabase, 'pa-brand', sourcePath, {
    inspectOptions: {
      requestedTier: '2k',
      requestedAspectRatio: '2:1',
      provider: 'fixture',
      model: 'fixture-model',
      contract: { mode: 'tier-long-edge', tier: '2k' },
    },
  })

  assert.equal(result.resolutionIntegrity.status, 'verified')
  assert.equal(result.resolutionIntegrity.publishable, true)
  assert.equal(result.variants.original.storagePath, sourcePath)
  assert.equal(result.variants.original.width, 2048)
  assert.equal(result.variants.thumbnail.kind, 'thumbnail')
  assert.equal(result.variants.thumbnail.width, 480)
  assert.equal(result.variants.thumbnail.height, 240)
  assert.equal(result.variants.thumbnail.format, 'webp')
  assert.equal(result.variants.thumbnail.sourceKind, 'original')
  assert.equal(result.thumbPath, result.variants.thumbnail.storagePath)
})
