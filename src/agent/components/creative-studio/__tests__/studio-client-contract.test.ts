import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STUDIO_NAV_DEFINITIONS,
  StudioClientError,
  estimateAudioJob,
  fetchGallery,
  fetchStudioReviewQueue,
  finishImage,
  isStudioView,
  normalizeStudioApiError,
  normalizeStudioView,
  queueAudioJob,
  runAutoStudioJob,
  runStudioJob,
  runVideoRecipe,
  studioRequest,
  transitionStudioReview,
} from '@/agent/components/creative-studio/studio-api'
import {
  buildStudioResolutionUiState,
  resolutionFieldsForRun,
} from '@/agent/components/creative-studio/resolution-ui'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>) {
  return requestAt(fetchMock, fetchMock.mock.calls.length - 1)
}

function requestAt(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const call = fetchMock.mock.calls[index]
  const [url, init] = call as [string, RequestInit | undefined]
  return {
    url,
    method: init?.method ?? 'GET',
    headers: init?.headers,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
  }
}

function signedEstimate(receiptId = 'receipt-123456') {
  return {
    receipt: `signed-${receiptId}`,
    receiptId,
    confirmBy: '2026-07-26T12:00:00.000Z',
    estimateBdt: 25,
    estimateUsd: 0.2,
    maxCostBdt: 500,
    requestFingerprint: 'request-fingerprint',
    selectionFingerprint: 'selection-fingerprint',
    selection: {
      mode: 'try_on',
      architecture: 'advanced',
      provider: 'fal',
      model: 'fal-ai/fashn/tryon/v1.6',
      providers: ['fal'],
      models: ['fal-ai/fashn/tryon/v1.6'],
      plan: ['single_vton'],
      paidAttemptLimit: 2,
    },
    confirmationRequired: true,
    providerCallMade: false,
  } as const
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Creative Studio navigation contract', () => {
  it('keeps the five owner-facing views and their Bangla labels stable', () => {
    expect(STUDIO_NAV_DEFINITIONS).toEqual([
      { id: 'studio', label: 'স্টুডিও' },
      { id: 'gallery', label: 'গ্যালারি' },
      { id: 'video', label: 'ভিডিও' },
      { id: 'audio', label: 'অডিও' },
      { id: 'library', label: 'লাইব্রেরি' },
    ])
  })

  it('accepts known view state and safely returns unknown state to Studio', () => {
    expect(isStudioView('gallery')).toBe(true)
    expect(isStudioView('settings')).toBe(false)
    expect(normalizeStudioView('audio')).toBe('audio')
    expect(normalizeStudioView(null)).toBe('studio')
    expect(normalizeStudioView('unexpected')).toBe('studio')
  })
})

describe('typed Studio client errors', () => {
  it('normalizes API codes into safe owner-facing Bangla', () => {
    const error = normalizeStudioApiError({ error: 'cost_cap_exceeded' }, 400, 'audio_failed')
    expect(error).toBeInstanceOf(StudioClientError)
    expect(error).toMatchObject({
      status: 400,
      code: 'cost_cap_exceeded',
      message: 'আপনার নির্ধারিত সর্বোচ্চ খরচের চেয়ে এই কাজের খরচ বেশি।',
    })
  })

  it('does not expose provider URLs, request ids, keys, or stack-like payloads', () => {
    const error = normalizeStudioApiError(
      {
        error: 'https://provider.invalid request_id=req_secret sk-live-secret stack trace',
      },
      500,
      'run_failed',
    )
    expect(error.code).toBe('run_failed')
    expect(error.message).toBe('কাজটি এখন সম্পন্ন করা যায়নি। একটু পরে আবার চেষ্টা করুন।')
    expect(error.message).not.toContain('provider.invalid')
    expect(error.message).not.toContain('secret')
  })

  it('normalizes network failures through the same typed boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed ECONNRESET')))
    await expect(studioRequest('/api/assistant/creative-studio/config', undefined, 'config_failed')).rejects.toMatchObject({
      name: 'StudioClientError',
      status: 0,
      code: 'config_failed',
      message: 'Provider-এর সাথে সংযোগ হচ্ছে না। একটু পরে Retry করুন।',
    })
  })
})

describe('Creative Studio request payload contract', () => {
  it('requests approved Review rows explicitly and sends the exact composition approval pin', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({
        review: {
          assetId: 'asset-1',
          currentState: 'approved',
        },
      }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchStudioReviewQueue({
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      includeApproved: true,
    })
    await transitionStudioReview({
      assetId: 'asset-1',
      brandProfileId: 'brand-1',
      targetState: 'approved',
      expectedSequence: 7,
      compositionId: 'composition-1',
      compositionVersionId: 'composition-version-4',
    })

    expect(requestAt(fetchMock, 0).url).toContain('includeApproved=true')
    expect(requestAt(fetchMock, 1).body).toMatchObject({
      brandProfileId: 'brand-1',
      targetState: 'approved',
      expectedSequence: 7,
      compositionId: 'composition-1',
      compositionVersionId: 'composition-version-4',
    })
  })

  it('requests an exact Review asset/version/sequence without a generic Gallery fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      items: [],
      hasMore: false,
      total: 0,
      nextCursor: null,
    }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGallery({
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      projectAssetId: 'asset-1',
      assetVersionId: 'version-3',
      reviewSequence: 7,
      limit: 48,
    })

    const request = lastRequest(fetchMock)
    expect(request.url).toContain('brandProfileId=brand-1')
    expect(request.url).toContain('projectId=project-1')
    expect(request.url).toContain('projectAssetId=asset-1')
    expect(request.url).toContain('assetVersionId=version-3')
    expect(request.url).toContain('reviewSequence=7')
  })

  it('omits inapplicable aspect and resolution from fixed-size Fal VTON payloads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(signedEstimate()))
      .mockResolvedValueOnce(jsonResponse({
        jobs: [],
        provider: 'fashn',
        message: 'queued',
      }))
    vi.stubGlobal('fetch', fetchMock)

    const resolutionState = buildStudioResolutionUiState(
      {
        mode: 'try_on',
        provider: 'fashn',
        vtonEngine: 'fal_fashn_v16',
        familyPreset: 'single',
        protectedComposite: false,
        imageEngine: 'gemini',
      },
      { aspectRatio: '4:5', resolution: '2k' },
    )

    await runStudioJob({
      mode: 'try_on',
      provider: 'fashn',
      vtonEngine: 'fal_fashn_v16',
      clothType: 'upper',
      productImagePath: 'studio/product.jpg',
      modelImagePath: 'studio/model.jpg',
      modelId: 'model-1',
      familyPreset: 'single',
      prompt: 'keep garment exact',
      backgroundPrompt: 'clean studio',
      ...resolutionFieldsForRun(resolutionState),
      generationMode: 'balanced',
      numImages: 1,
      durationSec: 6,
      vibe: 'premium',
    })

    expect(requestAt(fetchMock, 0).body).toMatchObject({
      intent: 'estimate',
      maxCostBdt: 500,
      studioSurface: 'legacy',
      vtonEngine: 'fal_fashn_v16',
    })
    expect(requestAt(fetchMock, 0).body).not.toHaveProperty('aspectRatio')
    expect(requestAt(fetchMock, 0).body).not.toHaveProperty('resolution')
    expect(lastRequest(fetchMock)).toMatchInlineSnapshot(`
      {
        "body": {
          "backgroundPrompt": "clean studio",
          "clothType": "upper",
          "confirmed": true,
          "durationSec": 6,
          "familyPreset": "single",
          "generationMode": "balanced",
          "idempotencyKey": "studio:receipt-123456",
          "intent": "confirm",
          "maxCostBdt": 500,
          "mode": "try_on",
          "modelId": "model-1",
          "modelImagePath": "studio/model.jpg",
          "numImages": 1,
          "productImagePath": "studio/product.jpg",
          "prompt": "keep garment exact",
          "provider": "fashn",
          "receipt": "signed-receipt-123456",
          "studioSurface": "legacy",
          "vibe": "premium",
          "vtonEngine": "fal_fashn_v16",
        },
        "headers": {
          "Content-Type": "application/json",
        },
        "method": "POST",
        "url": "/api/assistant/creative-studio/run",
      }
    `)
  })

  it('serializes the visible native xAI selection instead of hidden 4K/4:5 values', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(signedEstimate('receipt-xai')))
      .mockResolvedValueOnce(jsonResponse({
        jobs: [],
        provider: 'xai_imagine',
        message: 'queued',
      }))
    vi.stubGlobal('fetch', fetchMock)

    const resolutionState = buildStudioResolutionUiState(
      {
        mode: 'generate',
        provider: 'xai_imagine',
        vtonEngine: 'xai_imagine',
        familyPreset: 'single',
        protectedComposite: false,
        imageEngine: 'gemini',
      },
      { aspectRatio: '4:5', resolution: '4k' },
    )

    await runStudioJob({
      mode: 'generate',
      provider: 'fashn',
      vtonEngine: 'xai_imagine',
      prompt: 'Eid campaign',
      ...resolutionFieldsForRun(resolutionState),
    })

    expect(requestAt(fetchMock, 0).body).toMatchObject({
      mode: 'generate',
      provider: 'fashn',
      vtonEngine: 'xai_imagine',
      aspectRatio: '3:4',
      resolution: '2k',
      intent: 'estimate',
    })
    expect(requestAt(fetchMock, 0).body).not.toMatchObject({
      aspectRatio: '4:5',
      resolution: '4k',
    })
    expect(lastRequest(fetchMock).body).toMatchObject({
      intent: 'confirm',
      receipt: 'signed-receipt-xai',
      idempotencyKey: 'studio:receipt-xai',
    })
  })

  it('preserves Auto, audio estimate/queue, finishing, and video bodies', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock
      .mockResolvedValueOnce(jsonResponse(signedEstimate('receipt-auto')))
      .mockResolvedValueOnce(jsonResponse({ jobs: [], provider: 'auto', message: 'queued' }))
    await runAutoStudioJob({
      productImagePath: 'studio/product.jpg',
      includeFamily: true,
      includeReel: false,
    })
    expect(requestAt(fetchMock, 0).body).toEqual({
      auto: true,
      mode: 'try_on',
      productImagePath: 'studio/product.jpg',
      includeFamily: true,
      includeReel: false,
      studioSurface: 'legacy',
      intent: 'estimate',
      maxCostBdt: 500,
    })
    expect(requestAt(fetchMock, 1).body).toEqual({
      auto: true,
      mode: 'try_on',
      productImagePath: 'studio/product.jpg',
      includeFamily: true,
      includeReel: false,
      studioSurface: 'legacy',
      intent: 'confirm',
      receipt: 'signed-receipt-auto',
      confirmed: true,
      idempotencyKey: 'studio:receipt-auto',
      maxCostBdt: 500,
    })

    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
          requiresConfirmation: true,
          summary: 'music',
          costBdt: 34,
          maxCostBdt: 500,
        }))
      .mockResolvedValueOnce(
        jsonResponse({
          pendingActionId: 'audio-1',
          costBdt: 34,
          maxCostBdt: 500,
        }),
      )
    await estimateAudioJob({
      kind: 'music',
      styleId: 'celebration',
      seconds: 30,
    })
    expect(lastRequest(fetchMock).body).toEqual({
      kind: 'music',
      styleId: 'celebration',
      seconds: 30,
      intent: 'estimate',
    })

    await queueAudioJob({ kind: 'music', styleId: 'celebration', seconds: 30 }, { confirmedCostBdt: 34, costCapBdt: 500 })
    expect(lastRequest(fetchMock).body).toEqual({
      kind: 'music',
      styleId: 'celebration',
      seconds: 30,
      intent: 'queue',
      confirmedCostBdt: 34,
      costCapBdt: 500,
    })

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(jsonResponse({
          framedPath: 'finished/a.jpg',
          framedUrl: 'https://signed/image',
        }))

    await finishImage({
      storagePath: 'gallery/original.jpg',
      hook: 'ঈদ কালেকশন',
      productCode: 'AL-101',
      mode: 'model_overlay',
      pendingActionId: 'image-1',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      projectAssetId: 'asset-1',
    })
    expect(lastRequest(fetchMock).body).toEqual({
      storagePath: 'gallery/original.jpg',
      hook: 'ঈদ কালেকশন',
      productCode: 'AL-101',
      mode: 'model_overlay',
      pendingActionId: 'image-1',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      projectAssetId: 'asset-1',
    })

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(jsonResponse({ jobs: [], message: 'queued' }))
    await runVideoRecipe({
      videoPath: 'video/source.mp4',
      videoName: 'source.mp4',
      recipeId: 'product_showcase',
      targets: [16, 24],
      aspect: '9:16',
      options: {
        captions: true,
        audioMode: 'music_duck',
        musicTrackId: 'track-1',
        voiceoverText: 'নতুন কালেকশন',
        stings: true,
        aiAssist: false,
      },
    })
    expect(lastRequest(fetchMock).body).toEqual({
      videoPath: 'video/source.mp4',
      videoName: 'source.mp4',
      recipeId: 'product_showcase',
      targets: [16, 24],
      aspect: '9:16',
      options: {
        captions: true,
        audioMode: 'music_duck',
        musicTrackId: 'track-1',
        voiceoverText: 'নতুন কালেকশন',
        stings: true,
        aiAssist: false,
      },
    })
  })
})
