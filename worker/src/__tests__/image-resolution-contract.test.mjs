import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FAL_FASHN_V16_CONTRACT,
  resolveDirectFashnImageRequest,
  resolveGenericImageRequest,
  resolveXaiImageRequest,
  sourceDimensionsContract,
} from '../image-resolution-contract.mjs'

test('Gemini 3 tiers map to the exact Creative Studio dimensions and uppercase API token', () => {
  const one = resolveGenericImageRequest({
    modelName: 'gemini-3.1-flash-image',
    imageSize: '1K',
    aspectRatio: '4:5',
  })
  assert.equal(one.provider, 'gemini')
  assert.equal(one.providerImageSize, '1K')
  assert.deepEqual(one.dimensions, { width: 928, height: 1152 })

  const two = resolveGenericImageRequest({
    modelName: 'gemini-3-pro-image',
    imageSize: '2k',
    aspectRatio: '9:16',
  })
  assert.equal(two.providerImageSize, '2K')
  assert.deepEqual(two.dimensions, { width: 1536, height: 2752 })

  const four = resolveGenericImageRequest({
    modelName: 'gemini-3-pro-image',
    imageSize: '4K',
    aspectRatio: '16:9',
  })
  assert.equal(four.providerImageSize, '4K')
  assert.deepEqual(four.dimensions, { width: 5504, height: 3072 })
  assert.deepEqual(four.validationContract, {
    mode: 'exact',
    width: 5504,
    height: 3072,
    tolerance: 0,
  })
})

test('Gemini 2.5 is fixed near 1K and unknown configured models fail closed', () => {
  const fixed = resolveGenericImageRequest({
    modelName: 'gemini-2.5-flash-image',
    imageSize: '1k',
    aspectRatio: '1:1',
  })
  assert.equal(fixed.providerImageSize, '1K')
  assert.deepEqual(fixed.validationContract, { mode: 'tier-long-edge', tier: '1k' })
  assert.throws(
    () => resolveGenericImageRequest({
      modelName: 'gemini-2.5-flash-image',
      imageSize: '2k',
      aspectRatio: '1:1',
    }),
    /fixed at approximately 1K/,
  )
  assert.throws(
    () => resolveGenericImageRequest({
      modelName: 'unreviewed-image-model',
      imageSize: '1k',
      aspectRatio: '1:1',
    }),
    /no audited resolution contract/,
  )
})

test('GPT Image 2 receives exact aligned dimensions and only landscape/portrait 4K', () => {
  const portrait = resolveGenericImageRequest({
    modelName: 'gpt-image-2',
    imageSize: '2K',
    aspectRatio: '4:5',
  })
  assert.equal(portrait.provider, 'openai')
  assert.equal(portrait.providerImageSize, '1856x2304')
  assert.deepEqual(portrait.dimensions, { width: 1856, height: 2304 })

  const four = resolveGenericImageRequest({
    modelName: 'gpt-image-2',
    imageSize: '4k',
    aspectRatio: '16:9',
  })
  assert.equal(four.providerImageSize, '3840x2160')

  assert.throws(
    () => resolveGenericImageRequest({
      modelName: 'gpt-image-2',
      imageSize: '4k',
      aspectRatio: '1:1',
    }),
    /does not support 4K at 1:1/,
  )
  assert.throws(
    () => resolveGenericImageRequest({
      modelName: 'gpt-image-2',
      imageSize: '4k',
      aspectRatio: '4:5',
    }),
    /does not support 4K at 4:5/,
  )
})

test('Seedream tier controls exact dimensions; 4K is rejected before provider work', () => {
  const one = resolveGenericImageRequest({
    modelName: 'seedream-5.0-pro',
    imageSize: '1k',
    aspectRatio: '9:16',
  })
  assert.deepEqual(one.providerImageSize, { width: 768, height: 1376 })

  const two = resolveGenericImageRequest({
    modelName: 'seedream-5.0-pro',
    imageSize: '2k',
    aspectRatio: '4:5',
  })
  assert.deepEqual(two.providerImageSize, { width: 1824, height: 2272 })

  assert.throws(
    () => resolveGenericImageRequest({
      modelName: 'seedream-5.0-pro',
      imageSize: '4k',
      aspectRatio: '16:9',
    }),
    /does not support 4K/,
  )
})

test('xAI rejects false 4K and 4:5 claims; direct FASHN keeps native tiers', () => {
  const xai = resolveXaiImageRequest({ resolution: '2K', aspectRatio: '3:4' })
  assert.equal(xai.providerImageSize, '2k')
  assert.deepEqual(xai.validationContract, { mode: 'tier-long-edge', tier: '2k' })
  assert.throws(
    () => resolveXaiImageRequest({ resolution: '4k', aspectRatio: '16:9' }),
    /does not support 4K/,
  )
  assert.throws(
    () => resolveXaiImageRequest({ resolution: '2k', aspectRatio: '4:5' }),
    /does not support aspect ratio 4:5/,
  )

  assert.equal(resolveDirectFashnImageRequest('1K').providerImageSize, '1k')
  assert.equal(resolveDirectFashnImageRequest('4k').providerImageSize, '4k')
  assert.equal(
    resolveDirectFashnImageRequest('2k', {
      model: 'product-to-model',
      aspectRatio: '4:5',
    }).providerAspectRatio,
    '4:5',
  )
  assert.throws(
    () => resolveDirectFashnImageRequest('2k', {
      model: 'face-to-model',
      aspectRatio: '16:9',
    }),
    /does not support aspect ratio 16:9/,
  )
  assert.throws(() => resolveDirectFashnImageRequest('8k'), /unsupported image resolution tier/)
})

test('fixed Fal and source-sized contracts are explicit', () => {
  assert.deepEqual(FAL_FASHN_V16_CONTRACT, {
    mode: 'exact',
    width: 864,
    height: 1296,
    tolerance: 0,
  })
  assert.deepEqual(sourceDimensionsContract(1200, 1600), {
    mode: 'exact',
    width: 1200,
    height: 1600,
    tolerance: 0,
  })
  assert.throws(() => sourceDimensionsContract(0, 10), /positive integer/)
})
