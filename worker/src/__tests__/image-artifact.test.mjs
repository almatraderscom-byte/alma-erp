import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import {
  downloadImageArtifactToStorage,
  inspectImageArtifact,
  resolutionIntegrityFromArtifact,
  uploadImageArtifact,
} from '../image-artifact.mjs'

async function fixture(width, height, format, options = {}) {
  let pipeline = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 21, g: 73, b: 137, alpha: 1 },
    },
  })
  if (options.orientation) pipeline = pipeline.withMetadata({ orientation: options.orientation })
  if (format === 'jpeg') return pipeline.jpeg({ quality: 91 }).toBuffer()
  if (format === 'webp') return pipeline.webp({ quality: 88 }).toBuffer()
  return pipeline.png().toBuffer()
}

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

test('inspector decodes PNG/JPEG/WebP dimensions, MIME, size, and SHA-256', async () => {
  for (const [format, mimeType] of [
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ]) {
    const bytes = await fixture(96, 64, format)
    const artifact = await inspectImageArtifact(bytes)
    assert.equal(artifact.width, 96)
    assert.equal(artifact.height, 64)
    assert.equal(artifact.pixelCount, 6144)
    assert.equal(artifact.format, format)
    assert.equal(artifact.mimeType, mimeType)
    assert.equal(artifact.byteSize, bytes.length)
    assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(artifact.validation, 'verified')
  }
})

test('EXIF orientation is applied to reported width and height', async () => {
  const bytes = await fixture(80, 40, 'jpeg', { orientation: 6 })
  const artifact = await inspectImageArtifact(bytes)
  assert.equal(artifact.width, 40)
  assert.equal(artifact.height, 80)
})

test('real 2K and 4K fixture bytes pass truthful tier gates', async () => {
  const twoK = await fixture(2048, 2048, 'png')
  const inspectedTwoK = await inspectImageArtifact(twoK, {
    requestedTier: '2k',
    contract: { mode: 'tier-long-edge', tier: '2k' },
  })
  assert.equal(inspectedTwoK.actualTier, '2k')
  assert.equal(inspectedTwoK.validation, 'verified')

  const fourK = await fixture(3840, 2160, 'webp')
  const inspectedFourK = await inspectImageArtifact(fourK, {
    requestedTier: '4k',
    contract: { mode: 'exact', width: 3840, height: 2160, tolerance: 0 },
  })
  assert.equal(inspectedFourK.pixelCount, 8_294_400)
  assert.equal(inspectedFourK.actualTier, '4k')
  assert.equal(inspectedFourK.validation, 'verified')
})

test('dimension mismatch is preserved as evidence but marked non-publishable', async () => {
  const supabase = fakeSupabase()
  const bytes = await fixture(1024, 1024, 'png')
  const artifact = await uploadImageArtifact({
    supabase,
    buffer: bytes,
    storageBasePath: 'generated/provider-called-it.jpg',
    requestedTier: '2k',
    requestedAspectRatio: '1:1',
    provider: 'test',
    model: 'fixture',
    contract: { mode: 'exact', width: 2048, height: 2048, tolerance: 0 },
  })

  assert.equal(artifact.storagePath, 'generated/provider-called-it.png')
  assert.equal(artifact.validation, 'failed')
  assert.match(artifact.validationErrors[0], /expected 2048x2048, decoded 1024x1024/)
  const stored = supabase.uploaded.get(artifact.storagePath)
  assert.deepEqual(stored.bytes, bytes, 'provider bytes uploaded without recompression')
  assert.equal(stored.options.contentType, 'image/png')

  const integrity = resolutionIntegrityFromArtifact(artifact)
  assert.equal(integrity.status, 'failed')
  assert.equal(integrity.publishable, false)
  assert.equal(integrity.sha256, artifact.sha256)
})

test('URL content type and suffix cannot override decoded JPEG truth', async () => {
  const supabase = fakeSupabase()
  const bytes = await fixture(1024, 1024, 'jpeg')
  const artifact = await downloadImageArtifactToStorage({
    supabase,
    outputUrl: 'https://provider.invalid/output.png',
    storageBasePath: 'generated/sniff-me.png',
    requestedTier: '1k',
    contract: { mode: 'tier-long-edge', tier: '1k' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => bytes,
    }),
  })

  assert.equal(artifact.format, 'jpeg')
  assert.equal(artifact.mimeType, 'image/jpeg')
  assert.equal(artifact.storagePath, 'generated/sniff-me.jpg')
  assert.deepEqual(supabase.uploaded.get(artifact.storagePath).bytes, bytes)
})

test('empty and non-image artifacts are rejected', async () => {
  await assert.rejects(() => inspectImageArtifact(Buffer.alloc(0)), /artifact is empty/)
  await assert.rejects(
    () => inspectImageArtifact(Buffer.from('not an image')),
    /artifact is not decodable/,
  )
})
