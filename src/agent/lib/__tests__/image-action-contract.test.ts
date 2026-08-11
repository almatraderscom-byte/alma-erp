import { describe, expect, it } from 'vitest'
import {
  buildImageActionQuote,
  buildImageModelSelection,
  IMAGE_WORKER_CAPABILITY_KV_KEY,
  IMAGE_WORKER_CAPABILITY_MAX_AGE_MS,
  IMAGE_WORKER_CAPABILITY_SOURCE,
  IMAGE_WORKER_CAPABILITY_VERSION,
  imageModelAvailability,
  isImageActionQuoteForInputs,
  normalizeImageActionModel,
  selectionForImageAction,
} from '../image-action-contract'
import { GENERIC_IMAGE_MODELS } from '@/lib/creative-studio/advanced-image-capabilities'
import {
  IMAGE_WORKER_CAPABILITY_KV_KEY as WORKER_CAPABILITY_KV_KEY,
  IMAGE_WORKER_CAPABILITY_PUBLISH_INTERVAL_MS,
  IMAGE_WORKER_CAPABILITY_SOURCE as WORKER_CAPABILITY_SOURCE,
  IMAGE_WORKER_CAPABILITY_VERSION as WORKER_CAPABILITY_VERSION,
} from '../../../../worker/src/image/capability-receipt.mjs'
import { ALLOWED_GENERIC_IMAGE_MODELS as WORKER_GENERIC_MODELS } from '../../../../worker/src/image/reference-contract.mjs'

const NOW_MS = Date.parse('2026-08-11T06:00:00.000Z')

function workerReceipt(
  models: string[],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: IMAGE_WORKER_CAPABILITY_VERSION,
    source: IMAGE_WORKER_CAPABILITY_SOURCE,
    updatedAt: new Date(NOW_MS).toISOString(),
    models,
    ...overrides,
  })
}

describe('pending image action model and USD quote contract', () => {
  it('keeps the server and VPS capability protocol/model allowlist in lock-step', () => {
    expect(WORKER_CAPABILITY_KV_KEY).toBe(IMAGE_WORKER_CAPABILITY_KV_KEY)
    expect(WORKER_CAPABILITY_VERSION).toBe(IMAGE_WORKER_CAPABILITY_VERSION)
    expect(WORKER_CAPABILITY_SOURCE).toBe(IMAGE_WORKER_CAPABILITY_SOURCE)
    expect(WORKER_GENERIC_MODELS).toEqual([...GENERIC_IMAGE_MODELS])
    expect(IMAGE_WORKER_CAPABILITY_PUBLISH_INTERVAL_MS).toBeLessThan(IMAGE_WORKER_CAPABILITY_MAX_AGE_MS)
  })

  it('enables only models named by a fresh, exact worker receipt', () => {
    const availability = imageModelAvailability({
      workerCapabilities: workerReceipt([
        'gemini-3.1-flash-image',
        'gemini-3-pro-image',
        'gpt-image-2',
      ]),
      nowMs: NOW_MS,
    })
    expect(availability).toMatchObject({
      'gemini-3.1-flash-image': null,
      'gemini-3-pro-image': null,
      'gpt-image-2': null,
      'seedream-5.0-pro': expect.stringContaining('not configured'),
    })
  })

  it('fails every new model closed when the worker receipt is missing or stale', () => {
    const missing = imageModelAvailability({ workerCapabilities: null, nowMs: NOW_MS })
    const stale = imageModelAvailability({
      workerCapabilities: workerReceipt(
        ['gemini-3-pro-image'],
        { updatedAt: new Date(NOW_MS - IMAGE_WORKER_CAPABILITY_MAX_AGE_MS - 1).toISOString() },
      ),
      nowMs: NOW_MS,
    })
    for (const model of GENERIC_IMAGE_MODELS) {
      expect(missing[model]).toContain('missing')
      expect(stale[model]).toContain('stale')
    }
  })

  it('fails closed on capability version/source/model-list mismatch', () => {
    const mismatches = [
      workerReceipt(['gemini-3-pro-image'], { version: 2 }),
      workerReceipt(['gemini-3-pro-image'], { source: 'another-worker' }),
      workerReceipt(['gemini-3-pro-image', 'unreviewed-provider-model']),
      workerReceipt(['gemini-3-pro-image', 'gemini-3-pro-image']),
    ]
    for (const workerCapabilities of mismatches) {
      const availability = imageModelAvailability({ workerCapabilities, nowMs: NOW_MS })
      for (const model of GENERIC_IMAGE_MODELS) {
        expect(availability[model]).toContain('does not match')
      }
    }
  })

  it('pins the configured tier model instead of reading mutable config at execution', () => {
    expect(normalizeImageActionModel(undefined, 'pro', JSON.stringify({
      standard: 'gpt-image-2',
      pro: 'seedream-5.0-pro',
    }))).toBe('seedream-5.0-pro')
  })

  it('quotes a truthful render-only USD range for bounded production QC', () => {
    expect(buildImageActionQuote({
      model: 'gemini-3-pro-image',
      quality: 'pro',
      imageSize: '2K',
      requestedImages: 4,
      pipelineMode: 'production',
      aspectRatio: '4:5',
    })).toMatchObject({
      currency: 'USD',
      kind: 'provider_render_estimate',
      unitPriceUsd: 0.134,
      minCostUsd: 0.536,
      maxCostUsd: 1.608,
      maxPaidGenerationsPerImage: 3,
      excludes: ['qc_vision', 'taxes', 'provider_credits'],
    })
  })

  it('disables incompatible choices rather than silently downgrading resolution', () => {
    const selection = buildImageModelSelection({
      selectedModel: 'gemini-3-pro-image',
      quality: 'pro',
      imageSize: '4K',
      requestedImages: 1,
      pipelineMode: 'preview',
      aspectRatio: '4:5',
    })
    expect(selection.options.find((option) => option.id === 'seedream-5.0-pro')).toMatchObject({
      enabled: false,
      unavailableReason: expect.stringContaining('up to 2K'),
    })
    expect(selection.options.find((option) => option.id === 'gpt-image-2')).toMatchObject({
      enabled: false,
      unavailableReason: expect.stringContaining('only at 9:16 or 16:9'),
    })
  })

  it('prices a Flash selection at the Flash rate even on a pro-tier action', () => {
    expect(buildImageActionQuote({
      model: 'gemini-3.1-flash-image',
      quality: 'pro',
      imageSize: '2K',
      requestedImages: 1,
      pipelineMode: 'preview',
      aspectRatio: '4:5',
    })).toMatchObject({
      model: 'gemini-3.1-flash-image',
      quality: 'pro',
      unitPriceUsd: 0.101,
      minCostUsd: 0.101,
      maxCostUsd: 0.101,
    })
  })

  it('does not invent a committed picker or quote for an unpinned legacy card', () => {
    expect(selectionForImageAction({
      type: 'image_gen',
      payload: { quality: 'pro', imageSize: '2K', variationCount: 4 },
      imageModel: null,
      imageQuote: null,
    })).toBeNull()
  })

  it('keeps a legacy pinned card and quote readable while a missing receipt disables re-approval', () => {
    const quote = buildImageActionQuote({
      model: 'gpt-image-2',
      quality: 'pro',
      imageSize: '2K',
      requestedImages: 4,
      pipelineMode: 'preview',
      aspectRatio: '4:5',
    })
    const selection = selectionForImageAction({
      type: 'image_gen',
      payload: {
        quality: 'pro',
        imageSize: '2K',
        variationCount: 4,
        pipelineMode: 'preview',
        aspectRatio: '4:5',
      },
      imageModel: 'gpt-image-2',
      imageQuote: quote,
      availability: imageModelAvailability({ workerCapabilities: null, nowMs: NOW_MS }),
    })
    expect(selection).toMatchObject({
      selectedModel: 'gpt-image-2',
      quote,
    })
    expect(selection?.options.find((option) => option.id === 'gpt-image-2')).toMatchObject({
      enabled: false,
      unavailableReason: expect.stringContaining('missing'),
    })
  })

  it('accepts a quote only for the exact model, quality, size, count, and QC ceiling', () => {
    const quote = buildImageActionQuote({
      model: 'gpt-image-2',
      quality: 'pro',
      imageSize: '2K',
      requestedImages: 4,
      pipelineMode: 'production',
      aspectRatio: '4:5',
    })
    const exact = {
      model: 'gpt-image-2' as const,
      quality: 'pro' as const,
      imageSize: '2K' as const,
      requestedImages: 4,
      pipelineMode: 'production' as const,
    }
    expect(isImageActionQuoteForInputs(quote, exact)).toBe(true)
    expect(isImageActionQuoteForInputs(quote, { ...exact, model: 'gemini-3-pro-image' })).toBe(false)
    expect(isImageActionQuoteForInputs(quote, { ...exact, quality: 'standard' })).toBe(false)
    expect(isImageActionQuoteForInputs(quote, { ...exact, imageSize: '1K' })).toBe(false)
    expect(isImageActionQuoteForInputs(quote, { ...exact, requestedImages: 3 })).toBe(false)
    expect(isImageActionQuoteForInputs(quote, { ...exact, pipelineMode: 'preview' })).toBe(false)
  })

  it('does not project a stale persisted quote after immutable render inputs change', () => {
    const staleQuote = buildImageActionQuote({
      model: 'gemini-3-pro-image',
      quality: 'pro',
      imageSize: '2K',
      requestedImages: 1,
      pipelineMode: 'preview',
      aspectRatio: '4:5',
    })
    const selection = selectionForImageAction({
      type: 'image_gen',
      payload: {
        quality: 'pro',
        imageSize: '2K',
        variationCount: 4,
        pipelineMode: 'production',
        aspectRatio: '4:5',
      },
      imageModel: 'gemini-3-pro-image',
      imageQuote: staleQuote,
    })
    expect(selection?.quote).toMatchObject({
      requestedImages: 4,
      maxPaidGenerationsPerImage: 3,
      maxCostUsd: 1.608,
    })
  })
})
