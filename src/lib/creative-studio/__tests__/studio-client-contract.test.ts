import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STUDIO_NAV_DEFINITIONS,
  StudioClientError,
  estimateAudioJob,
  finishImage,
  isStudioView,
  normalizeStudioApiError,
  normalizeStudioView,
  queueAudioJob,
  runAutoStudioJob,
  runStudioJob,
  runVideoRecipe,
  studioRequest,
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
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  const [url, init] = call as [string, RequestInit | undefined]
  return {
    url,
    method: init?.method ?? 'GET',
    headers: init?.headers,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
  }
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
  it('omits inapplicable aspect and resolution from fixed-size Fal VTON payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        jobs: [],
        provider: 'fashn',
        message: 'queued',
      }),
    )
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

    expect(lastRequest(fetchMock)).toMatchInlineSnapshot(`
      {
        "body": {
          "backgroundPrompt": "clean studio",
          "clothType": "upper",
          "durationSec": 6,
          "familyPreset": "single",
          "generationMode": "balanced",
          "mode": "try_on",
          "modelId": "model-1",
          "modelImagePath": "studio/model.jpg",
          "numImages": 1,
          "productImagePath": "studio/product.jpg",
          "prompt": "keep garment exact",
          "provider": "fashn",
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
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        jobs: [],
        provider: 'xai_imagine',
        message: 'queued',
      }),
    )
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

    expect(lastRequest(fetchMock).body).toMatchObject({
      mode: 'generate',
      provider: 'fashn',
      vtonEngine: 'xai_imagine',
      aspectRatio: '3:4',
      resolution: '2k',
    })
    expect(lastRequest(fetchMock).body).not.toMatchObject({
      aspectRatio: '4:5',
      resolution: '4k',
    })
  })

  it('preserves Auto, audio estimate/queue, finishing, and video bodies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ jobs: [], provider: 'auto', message: 'queued' }))
      .mockResolvedValueOnce(
        jsonResponse({
          requiresConfirmation: true,
          summary: 'music',
          costBdt: 34,
          maxCostBdt: 500,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pendingActionId: 'audio-1',
          costBdt: 34,
          maxCostBdt: 500,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          framedPath: 'finished/a.jpg',
          framedUrl: 'https://signed/image',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ jobs: [], message: 'queued' }))
    vi.stubGlobal('fetch', fetchMock)

    await runAutoStudioJob({
      productImagePath: 'studio/product.jpg',
      includeFamily: true,
      includeReel: false,
    })
    expect(lastRequest(fetchMock).body).toEqual({
      auto: true,
      productImagePath: 'studio/product.jpg',
      includeFamily: true,
      includeReel: false,
    })

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

    await finishImage({
      storagePath: 'gallery/original.jpg',
      hook: 'ঈদ কালেকশন',
      productCode: 'AL-101',
      mode: 'model_overlay',
      pendingActionId: 'image-1',
    })
    expect(lastRequest(fetchMock).body).toEqual({
      storagePath: 'gallery/original.jpg',
      hook: 'ঈদ কালেকশন',
      productCode: 'AL-101',
      mode: 'model_overlay',
      pendingActionId: 'image-1',
    })

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
