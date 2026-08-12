import { describe, expect, it } from 'vitest'
import {
  AGENT_IMAGE_CONTROLS_V2_KV_KEY,
  IMAGE_PRESETS,
  IMAGE_RENDER_CONFIG_VERSION,
  IMAGE_RENDER_QUOTE_VERSION,
  IMAGE_WORKER_CAPABILITY_V2_KV_KEY,
  buildImageConfigEnvelope,
  buildImageRenderConfig,
  buildImageRenderQuote,
  buildImageRenderSelection,
  imageConfigFingerprint,
  isImageRenderQuoteForConfig,
  parseImageConfigEnvelope,
  parseImageRenderConfig,
  payloadMirrorFromConfig,
  payloadMirrorMatchesConfig,
  presetForAspect,
  readImageWorkerCapabilityV2,
  receiptSupports,
  renderSelectionForAction,
  resolveImageDimensions,
  v1QuoteFromConfig,
  type ImagePresetId,
  type ImageWorkerCapabilityV2,
} from '../image-config-contract'
import { isImageActionQuoteForInputs } from '../image-action-contract'
import { GENERIC_IMAGE_MODELS, type GenericImageModel } from '@/lib/creative-studio/advanced-image-capabilities'
import {
  IMAGE_PRESET_ASPECTS as WORKER_PRESET_ASPECTS,
  resolveGenericImageRequest as workerResolve,
  supportedPresetTiersForModel as workerPresetTiersUntyped,
} from '../../../../worker/src/image-resolution-contract.mjs'

const workerPresetTiers = workerPresetTiersUntyped as (
  model: string,
) => Record<string, Array<'1K' | '2K' | '4K'>>
import {
  IMAGE_RENDER_CONFIG_VERSION as WORKER_CONFIG_VERSION,
  IMAGE_WORKER_CAPABILITY_V2_KV_KEY as WORKER_V2_KV_KEY,
  IMAGE_WORKER_CAPABILITY_V2_VERSION as WORKER_V2_VERSION,
  makeImageWorkerCapabilityReceiptV2,
} from '../../../../worker/src/image/capability-receipt.mjs'
import {
  imageConfigFingerprint as workerFingerprint,
  verifyImageConfigPayload,
} from '../../../../worker/src/image/config-contract.mjs'

const NOW_MS = Date.parse('2026-08-11T06:00:00.000Z')
const TIERS = ['1K', '2K', '4K'] as const

function fullReceipt(overrides: Partial<ImageWorkerCapabilityV2> = {}): ImageWorkerCapabilityV2 {
  const presets: Record<string, Record<string, Array<'1K' | '2K' | '4K'>>> = {}
  for (const model of GENERIC_IMAGE_MODELS) {
    presets[model] = workerPresetTiers(model)
  }
  return {
    version: 2,
    source: 'alma-agent-worker',
    updatedAt: new Date(NOW_MS).toISOString(),
    configContractVersion: 1,
    models: [...GENERIC_IMAGE_MODELS],
    presets,
    ...overrides,
  }
}

function receiptJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...fullReceipt(), ...overrides })
}

function socialConfig(model: GenericImageModel = 'gpt-image-2') {
  return buildImageRenderConfig({
    model,
    presetId: 'social_post',
    imageSize: '2K',
    quality: 'standard',
    variationCount: 4,
    pipelineMode: 'preview',
  })
}

describe('image render config v2 — server/worker parity', () => {
  it('keeps preset taxonomy in lock-step with the worker', () => {
    const serverMap = Object.fromEntries(IMAGE_PRESETS.map((p) => [p.id, p.aspectRatio]))
    expect(serverMap).toEqual({ ...WORKER_PRESET_ASPECTS })
    expect(WORKER_V2_KV_KEY).toBe(IMAGE_WORKER_CAPABILITY_V2_KV_KEY)
    expect(WORKER_V2_VERSION).toBe(2)
    expect(WORKER_CONFIG_VERSION).toBe(IMAGE_RENDER_CONFIG_VERSION)
  })

  it('resolves the exact same dimensions the worker resolves, for every combination', () => {
    for (const model of GENERIC_IMAGE_MODELS) {
      for (const preset of IMAGE_PRESETS) {
        for (const tier of TIERS) {
          const server = resolveImageDimensions(model, tier, preset.aspectRatio)
          let worker: { width: number; height: number } | null = null
          try {
            const resolved = workerResolve({
              modelName: model, imageSize: tier, aspectRatio: preset.aspectRatio,
            })
            worker = resolved.dimensions
          } catch {
            worker = null
          }
          if (worker === null) {
            expect('unavailableReason' in server, `${model} ${preset.id} ${tier}`).toBe(true)
          } else {
            expect(server, `${model} ${preset.id} ${tier}`).toEqual(worker)
          }
        }
      }
    }
  })

  it('computes the identical fingerprint on server and worker', () => {
    const config = socialConfig()
    expect(imageConfigFingerprint('gpt-image-2', config))
      .toBe(workerFingerprint('gpt-image-2', config))
  })

  it('publishes a v2 receipt that proves poster only where the tables support it', () => {
    const receipt = makeImageWorkerCapabilityReceiptV2({
      env: {
        GEMINI_API_KEY: 'x', OPENAI_API_KEY: 'x', FAL_KEY: 'x',
      } as unknown as NodeJS.ProcessEnv,
      now: new Date(NOW_MS),
    }) as unknown as {
      version: number
      configContractVersion: number
      presets: Record<string, Record<string, string[]>>
    }
    expect(receipt.version).toBe(2)
    expect(receipt.configContractVersion).toBe(1)
    expect(receipt.presets['gpt-image-2'].poster).toEqual(['1K', '2K'])
    expect(receipt.presets['gpt-image-2'].reel_story).toEqual(['1K', '2K', '4K'])
    expect(receipt.presets['seedream-5.0-pro'].poster).toEqual(['1K', '2K'])
    expect(receipt.presets['gemini-3-pro-image'].poster).toEqual(['1K', '2K', '4K'])
  })
})

describe('image render quote v2', () => {
  it('binds every priced input including aspect and exact dimensions', () => {
    const base = socialConfig()
    const quote = buildImageRenderQuote('gpt-image-2', base)
    expect(quote.version).toBe(IMAGE_RENDER_QUOTE_VERSION)
    expect(quote.aspectRatio).toBe('4:5')
    expect(quote.width).toBe(1856)
    expect(quote.height).toBe(2304)
    expect(quote.pricedComponents).toEqual(['provider_output_render'])
    // GPT input tokens are explicitly excluded, never silently folded in.
    expect(quote.excludes).toContain('prompt_text_input_tokens')
    expect(quote.excludes).toContain('reference_image_input_tokens')
    // A different preset (different aspect/dimensions) changes the fingerprint
    // and therefore invalidates the old quote.
    const poster = buildImageRenderConfig({
      model: 'gpt-image-2', presetId: 'poster', imageSize: '2K',
      quality: 'standard', variationCount: 4, pipelineMode: 'preview',
    })
    expect(imageConfigFingerprint('gpt-image-2', poster))
      .not.toBe(quote.configFingerprint)
    expect(isImageRenderQuoteForConfig(quote, 'gpt-image-2', poster)).toBe(false)
    expect(isImageRenderQuoteForConfig(quote, 'gpt-image-2', base)).toBe(true)
  })

  it('changes the quote ceiling for count and quality edits', () => {
    const base = socialConfig()
    const oneImage = { ...base, variationCount: 1 }
    const q4 = buildImageRenderQuote('gpt-image-2', base)
    const q1 = buildImageRenderQuote('gpt-image-2', oneImage)
    expect(q4.minCostUsd).toBeCloseTo(q1.minCostUsd * 4, 6)
    const pro = buildImageRenderConfig({
      model: 'gpt-image-2', presetId: 'social_post', imageSize: '2K',
      quality: 'pro', variationCount: 4, pipelineMode: 'preview',
    })
    expect(buildImageRenderQuote('gpt-image-2', pro).unitPriceUsd)
      .toBeGreaterThan(q4.unitPriceUsd)
    expect(pro.providerQuality).toBe('high')
    expect(base.providerQuality).toBe('medium')
  })

  it('keeps the v1 mirror quote valid for an installed Build 102', () => {
    const config = socialConfig()
    const v1 = v1QuoteFromConfig('gpt-image-2', config)
    expect(isImageActionQuoteForInputs(v1, {
      model: 'gpt-image-2',
      quality: 'standard',
      imageSize: '2K',
      requestedImages: 4,
      pipelineMode: 'preview',
    })).toBe(true)
  })

  it('gemini and seedream never claim a provider quality switch', () => {
    for (const model of ['gemini-3-pro-image', 'seedream-5.0-pro'] as const) {
      const config = buildImageRenderConfig({
        model, presetId: 'square', imageSize: '2K',
        quality: 'pro', variationCount: 1, pipelineMode: 'preview',
      })
      expect(config.providerQuality).toBeNull()
    }
  })
})

describe('canonical envelope', () => {
  it('round-trips and rejects any tampered field', () => {
    const config = socialConfig()
    const envelope = buildImageConfigEnvelope('gpt-image-2', config)
    expect(parseImageConfigEnvelope(envelope, 'gpt-image-2')).not.toBeNull()
    // Model swap invalidates the fingerprint.
    expect(parseImageConfigEnvelope(envelope, 'gemini-3-pro-image')).toBeNull()
    // Width tamper invalidates it.
    const tampered = JSON.parse(JSON.stringify(envelope))
    tampered.config.width = 1024
    expect(parseImageConfigEnvelope(tampered, 'gpt-image-2')).toBeNull()
    // Count tamper invalidates it.
    const countTamper = JSON.parse(JSON.stringify(envelope))
    countTamper.config.variationCount = 1
    expect(parseImageConfigEnvelope(countTamper, 'gpt-image-2')).toBeNull()
  })

  it('rejects configs whose aspect does not match the preset', () => {
    const config = JSON.parse(JSON.stringify(socialConfig()))
    config.aspectRatio = '9:16'
    expect(parseImageRenderConfig(config)).toBeNull()
  })

  it('detects payload-mirror divergence', () => {
    const config = socialConfig()
    const mirror = payloadMirrorFromConfig('gpt-image-2', config)
    expect(payloadMirrorMatchesConfig(mirror, 'gpt-image-2', config)).toBe(true)
    expect(payloadMirrorMatchesConfig(
      { ...mirror, variationCount: 2 }, 'gpt-image-2', config)).toBe(false)
    expect(payloadMirrorMatchesConfig(
      { ...mirror, imageModel: 'gemini-3-pro-image' }, 'gpt-image-2', config)).toBe(false)
  })
})

describe('worker v2 receipt fail-closed reads', () => {
  it('accepts only a fresh, exact v2 receipt', () => {
    expect(readImageWorkerCapabilityV2(receiptJson(), NOW_MS).receipt).not.toBeNull()
    expect(readImageWorkerCapabilityV2(null, NOW_MS).receipt).toBeNull()
    expect(readImageWorkerCapabilityV2('not-json', NOW_MS).receipt).toBeNull()
    expect(readImageWorkerCapabilityV2(receiptJson({ version: 1 }), NOW_MS).receipt).toBeNull()
    expect(readImageWorkerCapabilityV2(receiptJson({ configContractVersion: 2 }), NOW_MS).receipt).toBeNull()
    const stale = receiptJson({ updatedAt: new Date(NOW_MS - 10 * 60_000).toISOString() })
    expect(readImageWorkerCapabilityV2(stale, NOW_MS).receipt).toBeNull()
  })

  it('gates options on the exact proven preset/tier', () => {
    const receipt = fullReceipt({
      presets: { 'gpt-image-2': { social_post: ['2K'] } },
      models: ['gpt-image-2'],
    })
    expect(receiptSupports(receipt, 'gpt-image-2', 'social_post', '2K')).toBe(true)
    expect(receiptSupports(receipt, 'gpt-image-2', 'social_post', '1K')).toBe(false)
    expect(receiptSupports(receipt, 'gpt-image-2', 'poster', '2K')).toBe(false)
    expect(receiptSupports(receipt, 'gemini-3-pro-image', 'social_post', '2K')).toBe(false)
    expect(receiptSupports(null, 'gpt-image-2', 'social_post', '2K')).toBe(false)
  })
})

describe('v2 projection', () => {
  it('projects the same authoritative structure from an action row', () => {
    const config = socialConfig()
    const envelope = buildImageConfigEnvelope('gpt-image-2', config)
    const selection = renderSelectionForAction({
      type: 'image_gen',
      imageModel: 'gpt-image-2',
      imageConfig: envelope,
      imageConfigRevision: 3,
      receipt: fullReceipt(),
    })
    expect(selection).not.toBeNull()
    expect(selection?.contractVersion).toBe(2)
    expect(selection?.revision).toBe(3)
    expect(selection?.config.width).toBe(1856)
    expect(selection?.quote.configFingerprint).toBe(envelope.fingerprint)
    expect(selection?.countOptions).toEqual([1, 2, 3, 4])
    // Disabled combinations stay visible with a reason.
    const gpt4kSquare = selection?.sizeOptions.find((s) => s.id === '4K')
    expect(gpt4kSquare?.enabled).toBe(false)
    expect(gpt4kSquare?.unavailableReason).toBeTruthy()
  })

  it('returns null for legacy v1 cards', () => {
    expect(renderSelectionForAction({
      type: 'image_gen',
      imageModel: 'gpt-image-2',
      imageConfig: null,
      imageConfigRevision: 0,
      receipt: fullReceipt(),
    })).toBeNull()
  })

  it('disables everything the live receipt does not prove', () => {
    const config = socialConfig()
    const envelope = buildImageConfigEnvelope('gpt-image-2', config)
    const selection = renderSelectionForAction({
      type: 'image_gen',
      imageModel: 'gpt-image-2',
      imageConfig: envelope,
      imageConfigRevision: 0,
      receipt: null,
      receiptUnavailableReason: 'Image worker v2 capability receipt is missing.',
    })
    expect(selection).not.toBeNull()
    for (const option of selection!.modelOptions) expect(option.enabled).toBe(false)
    for (const option of selection!.presetOptions) expect(option.enabled).toBe(false)
    // The pinned selection itself stays readable (read-only history).
    expect(selection!.config).toEqual(config)
  })
})

describe('worker payload verification', () => {
  function approvedPayload(model: GenericImageModel = 'gpt-image-2'): Record<string, unknown> {
    const config = socialConfig(model)
    return {
      imageModel: model,
      imageConfig: config,
      ...payloadMirrorFromConfig(model, config),
    }
  }

  it('passes an exact approved payload', () => {
    expect(verifyImageConfigPayload(approvedPayload())).toBeNull()
  })

  it('fails closed on fingerprint mismatch', () => {
    const payload = approvedPayload()
    payload.imageConfigFingerprint = 'deadbeef'
    expect(verifyImageConfigPayload(payload)).toMatch(/fingerprint mismatch/)
  })

  it('fails closed when mirror fields diverge from the canonical config', () => {
    const payload = approvedPayload() as Record<string, unknown>
    payload.variationCount = 1
    expect(verifyImageConfigPayload(payload)).toMatch(/variationCount diverged/)
  })

  it('fails closed when the config dimensions disagree with worker tables', () => {
    const payload = approvedPayload()
    const config = { ...(payload.imageConfig as Record<string, unknown>), width: 1024 }
    const model = 'gpt-image-2' as GenericImageModel
    // Re-sign the tampered config so ONLY the dimension check can catch it —
    // this is the defense if a compromised/buggy server signs bad dimensions.
    const resigned = {
      ...payload,
      imageConfig: config,
      imageConfigFingerprint: workerFingerprint(model, config),
    }
    expect(verifyImageConfigPayload(resigned)).toMatch(/dimensions mismatch/)
  })

  it('fails closed on an unsupported model/tier combination', () => {
    const config = {
      version: 1, presetId: 'poster', sizeMode: 'tier', aspectRatio: '2:3',
      imageSize: '4K', width: 3328, height: 4992, quality: 'standard',
      providerQuality: 'medium', variationCount: 1, pipelineMode: 'preview',
    }
    const payload = {
      imageModel: 'gpt-image-2',
      imageConfig: config,
      imageModel2: undefined,
      quality: 'standard',
      aspectRatio: '2:3',
      imageSize: '4K',
      variationCount: 1,
      imageConfigFingerprint: workerFingerprint('gpt-image-2', config),
    }
    expect(verifyImageConfigPayload(payload)).toMatch(/GPT Image does not support/)
  })
})

describe('kv keys', () => {
  it('pins the owner rollout flag name', () => {
    expect(AGENT_IMAGE_CONTROLS_V2_KV_KEY).toBe('agent_image_controls_v2')
  })
  it('maps every v1 aspect to a preset', () => {
    const expected: Record<string, ImagePresetId> = {
      '1:1': 'square', '4:5': 'social_post', '9:16': 'reel_story', '16:9': 'landscape', '2:3': 'poster',
    }
    for (const [aspect, preset] of Object.entries(expected)) {
      expect(presetForAspect(aspect)).toBe(preset)
    }
    expect(presetForAspect('3:4')).toBeNull()
  })
})
