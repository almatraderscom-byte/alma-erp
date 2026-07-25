import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import {
  inspectImageArtifact,
  resolutionIntegrityFromArtifact,
} from '../image-artifact.mjs'
import {
  resolveDirectFashnImageRequest,
  resolveGenericImageRequest,
} from '../image-resolution-contract.mjs'
import {
  requiredReferencePaths,
  validateOrderedReferenceContract,
} from '../image/reference-contract.mjs'
import {
  processFashnImageGen,
  validateFashnReferenceContract,
} from '../fashn/process.mjs'
import { processXaiImagine } from '../xai/adapter.mjs'

process.env.XAI_API_KEY = 'test-key'

test('generic model snapshot, ordered references, and decoded dimensions form one receipt', async () => {
  const payload = {
    referenceImageId: 'models/person.jpg',
    secondReferenceImageId: 'products/product.jpg',
    referenceContract: {
      actualModel: 'gpt-image-2',
      bindings: [
        { role: 'person', path: 'models/person.jpg', source: 'saved_model', required: true },
        { role: 'product', path: 'products/product.jpg', source: 'uploaded', required: true },
      ],
    },
  }
  const request = resolveGenericImageRequest({
    modelName: payload.referenceContract.actualModel,
    imageSize: '2K',
    aspectRatio: '1:1',
  })
  const bytes = await sharp({
    create: {
      width: request.dimensions.width,
      height: request.dimensions.height,
      channels: 3,
      background: { r: 12, g: 34, b: 56 },
    },
  }).png().toBuffer()
  const artifact = await inspectImageArtifact(bytes, {
    kind: 'original',
    storagePath: 'generated/fixture.png',
    requestedTier: request.requestedTier,
    requestedAspectRatio: request.requestedAspectRatio,
    provider: request.provider,
    model: request.model,
    contract: request.validationContract,
  })
  const integrity = resolutionIntegrityFromArtifact(artifact)

  assert.deepEqual(requiredReferencePaths(payload), [
    'models/person.jpg',
    'products/product.jpg',
  ])
  assert.equal(artifact.provider, 'openai')
  assert.equal(artifact.model, 'gpt-image-2')
  assert.equal(artifact.width, 2048)
  assert.equal(artifact.height, 2048)
  assert.equal(artifact.validation, 'verified')
  assert.equal(integrity.publishable, true)
  assert.equal(integrity.actualTier, '2k')
  assert.match(integrity.sha256, /^[a-f0-9]{64}$/)
})

test('xAI rejects unsupported 4K before reference transport or a paid fetch', async (t) => {
  let storageReads = 0
  let fetchCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls++
    throw new Error('network must not be reached')
  }
  t.after(() => { globalThis.fetch = realFetch })

  const supabase = {
    storage: {
      from() {
        return {
          download: async () => {
            storageReads++
            return { data: null, error: new Error('must not load') }
          },
        }
      },
    },
  }
  await assert.rejects(
    processXaiImagine({
      supabase,
      pendingActionId: 'xai-unsupported-4k',
      payload: {
        xaiModel: 'grok-imagine-image-quality',
        xaiOp: 'edit',
        resolution: '4k',
        aspectRatio: '3:4',
        prompt: 'compose',
        referenceImagePaths: ['models/person.jpg', 'products/product.jpg'],
        referenceRoles: ['person', 'garment'],
        referenceContract: {
          actualModel: 'grok-imagine-image-quality',
          bindings: [
            { role: 'person', path: 'models/person.jpg', required: true },
            { role: 'product', path: 'products/product.jpg', required: true },
          ],
        },
      },
      logCost: () => {},
    }),
    /does not support 4K/,
  )
  assert.equal(storageReads, 0)
  assert.equal(fetchCalls, 0)
})

test('direct FASHN face_reference and resolution checks fail closed before execution', async (t) => {
  const inputs = {
    product_image: 'products/p.jpg',
    face_reference: 'models/m.jpg',
    face_reference_mode: 'match_reference',
  }
  const contract = {
    actualModel: 'product-to-model',
    bindings: [
      { role: 'product', path: 'products/p.jpg', required: true },
      { role: 'person', path: 'models/m.jpg', required: true },
    ],
  }
  assert.doesNotThrow(() => validateFashnReferenceContract(inputs, contract))
  assert.deepEqual(
    resolveDirectFashnImageRequest('4k', {
      model: 'product-to-model',
      aspectRatio: '4:5',
    }),
    {
      requestedTier: '4k',
      requestedAspectRatio: '4:5',
      providerImageSize: '4k',
      providerAspectRatio: '4:5',
      validationContract: {
        mode: 'tier-long-edge',
        tier: '4k',
        minPixelCount: 8_294_400,
      },
    },
  )

  let fetchCalls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls++
    throw new Error('network must not be reached')
  }
  t.after(() => { globalThis.fetch = realFetch })
  await assert.rejects(
    processFashnImageGen({
      supabase: {},
      pendingActionId: 'fashn-model-mismatch',
      payload: {
        fashnModel: 'product-to-model',
        fashnInputs: inputs,
        fashnOptions: { resolution: '4k', aspectRatio: '4:5' },
        referenceContract: { ...contract, actualModel: 'tryon-max' },
      },
      logCost: () => {},
    }),
    /fashn model snapshot mismatch/,
  )
  assert.equal(fetchCalls, 0)
})

test('Fal adapters validate immutable role order and model before transport', () => {
  const contract = {
    actualModel: 'fal-ai/fashn/tryon/v1.6',
    bindings: [
      { role: 'person', path: 'models/m.jpg', required: true },
      { role: 'product', path: 'products/p.jpg', required: true },
    ],
  }
  assert.doesNotThrow(() => validateOrderedReferenceContract(contract, {
    actualModel: 'fal-ai/fashn/tryon/v1.6',
    bindings: [
      { role: 'person', path: 'models/m.jpg' },
      { role: 'product', path: 'products/p.jpg' },
    ],
  }))
  assert.throws(
    () => validateOrderedReferenceContract(contract, {
      actualModel: 'fal-ai/fashn/tryon/v1.6',
      bindings: [
        { role: 'product', path: 'products/p.jpg' },
        { role: 'person', path: 'models/m.jpg' },
      ],
    }),
    /order mismatch at 1/,
  )
  assert.throws(
    () => validateOrderedReferenceContract(contract, {
      actualModel: 'fal-ai/cat-vton',
      bindings: contract.bindings,
    }),
    /model snapshot mismatch/,
  )
})
