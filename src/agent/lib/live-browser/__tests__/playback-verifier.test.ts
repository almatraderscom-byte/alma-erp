import { describe, expect, it } from 'vitest'
import {
  mediaSelectionMatchesOwnerRequest,
  playbackExpectationMatchesRequest,
  verifyBrowserPlayback,
  type BrowserMediaItem,
  type BrowserMediaSnapshot,
} from '../playback-verifier'

function mediaItem(overrides: Partial<BrowserMediaItem> = {}): BrowserMediaItem {
  return {
    index: 0,
    kind: 'video',
    mediaId: 'media-1',
    primary: true,
    playing: true,
    paused: false,
    ended: false,
    muted: false,
    volume: 1,
    currentTime: 14,
    readyState: 4,
    visible: true,
    viewportWidth: 900,
    viewportHeight: 506,
    viewportArea: 455400,
    exposedPointCount: 5,
    centerExposed: true,
    youtubeVideoId: 'abc123XYZ_-',
    youtubeTitle: 'Coke Studio Bangla – Bhober Pagol | Official',
    ...overrides,
  }
}

function sample(overrides: Partial<BrowserMediaSnapshot> = {}): BrowserMediaSnapshot {
  return {
    url: 'https://www.youtube.com/watch?v=abc123XYZ_-',
    title: 'Coke Studio Bangla – Bhober Pagol | Official - YouTube',
    documentId: 'document-1',
    youtube: {
      videoId: 'abc123XYZ_-',
      canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-',
      title: 'Coke Studio Bangla – Bhober Pagol | Official',
    },
    media: {
      count: 1,
      playing: true,
      adPlaying: false,
      tabMuted: false,
      tabActive: true,
      windowFocused: true,
      items: [mediaItem()],
    },
    ...overrides,
  }
}

function withItem(item: BrowserMediaItem, extra: Partial<NonNullable<BrowserMediaSnapshot['media']>> = {}) {
  return { ...sample().media, ...extra, items: [item] }
}

describe('verifyBrowserPlayback', () => {
  it('requires matching YouTube title and one visible advancing unmuted player', () => {
    const result = verifyBrowserPlayback({
      expectedMedia: 'Coke Studio Bangla গানটা চালাও',
      expectedHost: 'youtube.com',
      before: sample({ media: withItem(mediaItem({ currentTime: 12.8 })) }),
      after: sample(),
    })

    expect(result).toMatchObject({
      verified: true,
      hostMatched: true,
      canonicalMediaPage: true,
      titleMatched: true,
      mediaPageIdentityMatched: true,
      mediaTitleMatched: true,
      sameDocument: true,
      sameMedia: true,
      mediaVisible: true,
      mediaPlaying: true,
      mediaReady: true,
      mediaAudible: true,
      foregroundWitnessed: true,
      timeAdvanced: true,
      adPlaying: false,
    })
  })

  it('does not accept a click or paused player as proof', () => {
    const after = sample({
      media: withItem(mediaItem({ playing: false, paused: true, currentTime: 12.8 }), { playing: false }),
    })
    const result = verifyBrowserPlayback({
      expectedMedia: 'Coke Studio Bangla', expectedHost: 'youtube.com',
      before: sample({ media: withItem(mediaItem({ currentTime: 12.8 })) }), after,
    })

    expect(result.verified).toBe(false)
    expect(result.reasons).toContain('media_not_playing')
    expect(result.reasons).toContain('time_not_advancing')
  })

  it('rejects a playing ad and a non-advancing player', () => {
    const before = sample({ media: withItem(mediaItem(), { adPlaying: true }) })
    const result = verifyBrowserPlayback({ expectedMedia: 'Coke Studio Bangla', expectedHost: 'youtube.com', before, after: sample() })

    expect(result.verified).toBe(false)
    expect(result.reasons).toEqual(expect.arrayContaining(['time_not_advancing', 'ad_playing']))
  })

  it('rejects element mute, tab mute, and missing audio fields', () => {
    for (const after of [
      sample({ media: withItem(mediaItem({ currentTime: 5, muted: true })) }),
      sample({ media: withItem(mediaItem({ currentTime: 5 }), { tabMuted: true }) }),
      sample({ media: withItem(mediaItem({ currentTime: 5, muted: undefined, volume: undefined })) }),
    ]) {
      const before = sample({ media: withItem(mediaItem({ currentTime: 4 })) })
      const result = verifyBrowserPlayback({ expectedMedia: 'Coke Studio Bangla', expectedHost: 'youtube.com', before, after })
      expect(result.verified).toBe(false)
      expect(result.reasons).toContain('media_muted')
    }
  })

  it('rejects the wrong title or host even when another video is playing', () => {
    const result = verifyBrowserPlayback({
      expectedMedia: 'Interstellar soundtrack',
      expectedHost: 'youtube.com',
      before: sample({ url: 'https://example.com/watch', media: withItem(mediaItem({ currentTime: 10 })) }),
      after: sample({ url: 'https://example.com/watch' }),
    })

    expect(result.verified).toBe(false)
    expect(result.reasons).toEqual(expect.arrayContaining(['wrong_host', 'title_mismatch']))
  })

  it('rejects same-artist overlap with the wrong song', () => {
    const before = sample({
      title: 'Taylor Swift – Blank Space - YouTube',
      youtube: {
        videoId: 'abc123XYZ_-', canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-',
        title: 'Taylor Swift – Blank Space',
      },
      media: withItem(mediaItem({
        currentTime: 10, youtubeTitle: 'Taylor Swift – Blank Space',
      })),
    })
    const after = sample({
      title: 'Taylor Swift – Blank Space - YouTube',
      youtube: {
        videoId: 'abc123XYZ_-', canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-',
        title: 'Taylor Swift – Blank Space',
      },
      media: withItem(mediaItem({
        currentTime: 11, youtubeTitle: 'Taylor Swift – Blank Space',
      })),
    })
    const result = verifyBrowserPlayback({
      expectedMedia: 'Taylor Swift Love Story', expectedHost: 'youtube.com', before, after,
    })

    expect(result.verified).toBe(false)
    expect(result.reasons).toContain('title_mismatch')
  })

  it('rejects an unrequested karaoke/reaction variant even when the base title matches', () => {
    const before = sample({
      youtube: {
        videoId: 'abc123XYZ_-', canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-',
        title: 'Coldplay – Fix You Karaoke Cover',
      },
      media: withItem(mediaItem({
        currentTime: 10, youtubeTitle: 'Coldplay – Fix You Karaoke Cover',
      })),
    })
    const after = sample({
      youtube: {
        videoId: 'abc123XYZ_-', canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-',
        title: 'Coldplay – Fix You Karaoke Cover',
      },
      media: withItem(mediaItem({
        currentTime: 11, youtubeTitle: 'Coldplay – Fix You Karaoke Cover',
      })),
    })

    const result = verifyBrowserPlayback({
      ownerRequest: 'Play Fix You on YouTube',
      expectedMedia: 'Fix You',
      expectedHost: 'youtube.com',
      before,
      after,
    })
    expect(result.verified).toBe(false)
    expect(result.mediaVariantMatched).toBe(false)
    expect(result.unrequestedMediaVariants).toEqual(expect.arrayContaining(['karaoke', 'cover']))
    expect(result.reasons).toContain('unrequested_media_variant')
  })

  it('preserves title-significant pronouns such as Fix You versus Fix It', () => {
    const before = sample({
      youtube: {
        videoId: 'abc123XYZ_-', canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-',
        title: 'Fix It by Random Artist',
      },
      media: withItem(mediaItem({
        currentTime: 5, youtubeTitle: 'Fix It by Random Artist',
      })),
    })
    const after = sample({
      youtube: {
        videoId: 'abc123XYZ_-', canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-',
        title: 'Fix It by Random Artist',
      },
      media: withItem(mediaItem({
        currentTime: 6, youtubeTitle: 'Fix It by Random Artist',
      })),
    })

    const result = verifyBrowserPlayback({
      expectedMedia: 'Fix You', expectedHost: 'youtube.com', before, after,
    })
    expect(result.verified).toBe(false)
    expect(result.reasons).toEqual(expect.arrayContaining(['title_mismatch', 'youtube_media_title_mismatch']))
  })

  it.each([
    ['Interstellar soundtrack', 'Interstellar trailer review'],
    ['Fix You official audio', 'Fix You karaoke remix'],
  ])('rejects the wrong media variant: requested %s, playing %s', (expectedMedia, wrongTitle) => {
    const youtube = {
      videoId: 'abc123XYZ_-', canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-',
      title: wrongTitle,
    }
    const before = sample({
      youtube,
      media: withItem(mediaItem({ currentTime: 4, youtubeTitle: wrongTitle })),
    })
    const after = sample({
      youtube,
      media: withItem(mediaItem({ currentTime: 5, youtubeTitle: wrongTitle })),
    })

    const result = verifyBrowserPlayback({
      expectedMedia, expectedHost: 'youtube.com', before, after,
    })
    expect(result.verified).toBe(false)
    expect(result.reasons).toEqual(expect.arrayContaining(['title_mismatch', 'youtube_media_title_mismatch']))
  })

  it.each(['Me', 'You'])('does not treat the one-word title %s as a generic request', (requestedTitle) => {
    const wrongTitle = 'Despacito'
    const youtube = {
      videoId: 'abc123XYZ_-', canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-',
      title: wrongTitle,
    }
    const before = sample({
      youtube,
      media: withItem(mediaItem({ currentTime: 1, youtubeTitle: wrongTitle })),
    })
    const after = sample({
      youtube,
      media: withItem(mediaItem({ currentTime: 2, youtubeTitle: wrongTitle })),
    })

    expect(verifyBrowserPlayback({
      expectedMedia: requestedTitle, expectedHost: 'youtube.com', before, after,
    }).verified).toBe(false)
  })

  it('rejects canonical watch page X when the visible player is video Y or lacks local identity', () => {
    const before = sample({ media: withItem(mediaItem({ currentTime: 1 })) })
    for (const youtubeVideoId of ['wrongVID001', undefined]) {
      const after = sample({
        media: withItem(mediaItem({ currentTime: 2, youtubeVideoId })),
      })
      const result = verifyBrowserPlayback({
        expectedMedia: 'Coke Studio Bangla', expectedHost: 'youtube.com', before, after,
      })
      expect(result.verified).toBe(false)
      expect(result.reasons).toContain('youtube_media_page_identity_mismatch')
    }
  })

  it('accepts a canonical Shorts page whose player identity and title are bound', () => {
    const url = 'https://www.youtube.com/shorts/shortsID001'
    const youtube = { videoId: 'shortsID001', canonicalUrl: url, title: 'Requested Short' }
    const before = sample({
      url,
      youtube,
      media: withItem(mediaItem({
        currentTime: 3, youtubeVideoId: 'shortsID001', youtubeTitle: 'Requested Short',
      })),
    })
    const after = sample({
      url,
      youtube,
      media: withItem(mediaItem({
        currentTime: 4, youtubeVideoId: 'shortsID001', youtubeTitle: 'Requested Short',
      })),
    })

    expect(verifyBrowserPlayback({
      expectedMedia: 'Requested Short', expectedHost: 'youtube.com', before, after,
    }).verified).toBe(true)
  })

  it('rejects a matching search-results title with an unrelated visible advancing miniplayer', () => {
    const url = 'https://www.youtube.com/results?search_query=coke+studio+bangla'
    const before = sample({
      url,
      title: 'Coke Studio Bangla - YouTube',
      youtube: undefined,
      media: withItem(mediaItem({
        currentTime: 10,
        youtubeVideoId: 'wrongVID001',
        youtubeTitle: 'Unrelated miniplayer song',
      })),
    })
    const after = sample({
      url,
      title: 'Coke Studio Bangla - YouTube',
      youtube: undefined,
      media: withItem(mediaItem({
        currentTime: 11,
        youtubeVideoId: 'wrongVID001',
        youtubeTitle: 'Unrelated miniplayer song',
      })),
    })

    const result = verifyBrowserPlayback({
      expectedMedia: 'Coke Studio Bangla', expectedHost: 'youtube.com', before, after,
    })
    expect(result.verified).toBe(false)
    expect(result.reasons).toEqual(expect.arrayContaining([
      'youtube_final_url_or_page_identity_mismatch',
      'youtube_media_page_identity_mismatch',
      'youtube_media_title_mismatch',
    ]))
  })

  it('requires an explicit host, stable document/media identity, and visible primary player', () => {
    const before = sample({ media: withItem(mediaItem({ currentTime: 1 })) })
    const cases = [
      verifyBrowserPlayback({ expectedMedia: 'Coke Studio Bangla', before, after: sample() }),
      verifyBrowserPlayback({
        expectedMedia: 'Coke Studio Bangla', expectedHost: 'youtube.com', before,
        after: sample({ documentId: 'document-2' }),
      }),
      verifyBrowserPlayback({
        expectedMedia: 'Coke Studio Bangla', expectedHost: 'youtube.com', before,
        after: sample({ media: withItem(mediaItem({ mediaId: 'media-2', currentTime: 2 })) }),
      }),
      verifyBrowserPlayback({
        expectedMedia: 'Coke Studio Bangla', expectedHost: 'youtube.com', before,
        after: sample({ media: withItem(mediaItem({ currentTime: 2, visible: false, primary: false })) }),
      }),
    ]

    expect(cases[0].reasons).toContain('expected_host_missing')
    expect(cases[1].reasons).toContain('document_changed')
    expect(cases[2].reasons).toContain('media_identity_changed')
    expect(cases[3].reasons).toContain('media_not_visible')
    expect(cases.every((result) => !result.verified)).toBe(true)
  })

  it('rejects tiny and almost-entirely-covered players even if visible=true is asserted', () => {
    const before = sample({ media: withItem(mediaItem({ currentTime: 1 })) })
    for (const item of [
      mediaItem({
        currentTime: 2, viewportWidth: 1, viewportHeight: 1, viewportArea: 1,
      }),
      mediaItem({
        currentTime: 2, exposedPointCount: 1, centerExposed: false,
      }),
    ]) {
      const result = verifyBrowserPlayback({
        expectedMedia: 'Coke Studio Bangla', expectedHost: 'youtube.com', before,
        after: sample({ media: withItem(item) }),
      })
      expect(result.verified).toBe(false)
      expect(result.reasons).toContain('media_not_visible')
    }
  })

  it('requires both samples to come from the active tab in a focused window', () => {
    const active = sample({ media: withItem(mediaItem({ currentTime: 2 })) })
    for (const before of [
      sample({ media: withItem(mediaItem({ currentTime: 1 }), { tabActive: false }) }),
      sample({ media: withItem(mediaItem({ currentTime: 1 }), { windowFocused: false }) }),
    ]) {
      const result = verifyBrowserPlayback({
        expectedMedia: 'Coke Studio Bangla', expectedHost: 'youtube.com', before, after: active,
      })
      expect(result.verified).toBe(false)
      expect(result.reasons).toContain('media_not_foreground_witnessed')
    }
  })

  it('supports a meaningful one-word request', () => {
    const before = sample({
      title: 'Interstellar - YouTube',
      youtube: {
        videoId: 'abc123XYZ_-', canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-', title: 'Interstellar',
      },
      media: withItem(mediaItem({ currentTime: 1, youtubeTitle: 'Interstellar' })),
    })
    const after = sample({
      title: 'Interstellar - YouTube',
      youtube: {
        videoId: 'abc123XYZ_-', canonicalUrl: 'https://www.youtube.com/watch?v=abc123XYZ_-', title: 'Interstellar',
      },
      media: withItem(mediaItem({ currentTime: 2, youtubeTitle: 'Interstellar' })),
    })
    expect(verifyBrowserPlayback({ expectedMedia: 'Interstellar', expectedHost: 'youtube.com', before, after }).verified)
      .toBe(true)
  })

  it('uses the extracted owner media title instead of model-authored expectedMedia', () => {
    const before = sample({ media: withItem(mediaItem({ currentTime: 1 })) })
    const after = sample({ media: withItem(mediaItem({ currentTime: 2 })) })
    const result = verifyBrowserPlayback({
      ownerRequest: 'I want you to play Coke Studio Bangla using My Mac Chrome on YouTube',
      ownerDevice: { id: 'dev-1', name: 'My Mac Chrome', online: true },
      expectedMedia: 'Despacito',
      expectedHost: 'youtube.com',
      before,
      after,
    })

    expect(result.verified).toBe(true)
    expect(result.expectedMedia).toBe('coke studio bangla')
    expect(result.matchedTitleTokens).toEqual(expect.arrayContaining(['coke', 'studio', 'bangla']))
  })

  it('requires final playback to remain on the exact result bound before click', () => {
    const switchedVideoId = 'wrongVID001'
    const switchedUrl = `https://www.youtube.com/watch?v=${switchedVideoId}`
    const youtube = {
      videoId: switchedVideoId,
      canonicalUrl: switchedUrl,
      title: 'Fix You',
    }
    const before = sample({
      url: switchedUrl,
      youtube,
      media: withItem(mediaItem({
        currentTime: 1,
        youtubeVideoId: switchedVideoId,
        youtubeTitle: 'Fix You',
      })),
    })
    const after = sample({
      url: switchedUrl,
      youtube,
      media: withItem(mediaItem({
        currentTime: 2,
        youtubeVideoId: switchedVideoId,
        youtubeTitle: 'Fix You',
      })),
    })
    const result = verifyBrowserPlayback({
      ownerRequest: 'Play Fix You on YouTube',
      expectedMedia: 'Fix You',
      expectedHost: 'youtube.com',
      selectedMedia: { videoId: 'selected001', title: 'Fix You' },
      before,
      after,
    })

    expect(result.verified).toBe(false)
    expect(result.selectedMediaIdentityMatched).toBe(false)
    expect(result.reasons).toContain('selected_media_identity_mismatch')
  })

  it.each(['Fix You piano tutorial', 'Fix You guitar lesson']) (
    'rejects final player semantic drift from the bound result: %s',
    (wrongTitle) => {
      const youtube = {
        videoId: 'selected001',
        canonicalUrl: 'https://www.youtube.com/watch?v=selected001',
        title: wrongTitle,
      }
      const before = sample({
        url: youtube.canonicalUrl,
        youtube,
        media: withItem(mediaItem({
          currentTime: 1,
          youtubeVideoId: youtube.videoId,
          youtubeTitle: wrongTitle,
        })),
      })
      const after = sample({
        url: youtube.canonicalUrl,
        youtube,
        media: withItem(mediaItem({
          currentTime: 2,
          youtubeVideoId: youtube.videoId,
          youtubeTitle: wrongTitle,
        })),
      })
      const result = verifyBrowserPlayback({
        ownerRequest: 'Play Fix You on YouTube',
        expectedMedia: 'Fix You',
        expectedHost: 'youtube.com',
        selectedMedia: { videoId: youtube.videoId, title: 'Fix You' },
        before,
        after,
      })

      expect(result.verified).toBe(false)
      expect(result.selectedMediaTitleMatched).toBe(false)
      expect(result.reasons).toContain('selected_media_title_mismatch')
    },
  )
})

describe('playbackExpectationMatchesRequest', () => {
  it('binds proof expectation to every meaningful owner-query token', () => {
    expect(playbackExpectationMatchesRequest(
      'Play Fix You by Coldplay on YouTube', 'Coldplay Fix You',
    )).toBe(true)
    expect(playbackExpectationMatchesRequest(
      'Play Taylor Swift Love Story on YouTube', 'Taylor Swift Blank Space',
    )).toBe(false)
    expect(playbackExpectationMatchesRequest('Play Fix You on YouTube', 'Fix It')).toBe(false)
    expect(playbackExpectationMatchesRequest('Play Me on YouTube', 'Despacito')).toBe(false)
    expect(playbackExpectationMatchesRequest('Play Me on YouTube', 'Me')).toBe(true)
    expect(playbackExpectationMatchesRequest('Play You on YouTube', 'Despacito')).toBe(false)
    expect(playbackExpectationMatchesRequest('Play You on YouTube', 'You')).toBe(true)
    expect(playbackExpectationMatchesRequest(
      'Play Fix You on YouTube', 'Fix You karaoke remix',
    )).toBe(false)
    expect(playbackExpectationMatchesRequest(
      'Play Interstellar soundtrack on YouTube', 'Interstellar trailer review',
    )).toBe(false)
    expect(playbackExpectationMatchesRequest(
      'Play Interstellar soundtrack on YouTube', 'Interstellar soundtrack',
    )).toBe(true)
    expect(playbackExpectationMatchesRequest(
      'Play Fix You official audio on YouTube', 'Fix You karaoke remix',
    )).toBe(false)
    expect(playbackExpectationMatchesRequest(
      'Play Fix You official audio on YouTube', 'Fix You official audio',
    )).toBe(true)
    expect(playbackExpectationMatchesRequest(
      'Play Fix You with lyrics on YouTube', 'Fix You',
    )).toBe(false)
    expect(playbackExpectationMatchesRequest(
      'Play Fix You with lyrics on YouTube', 'Fix You with lyrics',
    )).toBe(true)
    expect(playbackExpectationMatchesRequest(
      'Play Dancing With Your Ghost on YouTube', 'Dancing With Your Ghost',
    )).toBe(true)
    expect(playbackExpectationMatchesRequest(
      'Play On My Way on YouTube', 'On My Way',
    )).toBe(true)
  })

  it('allows a concrete choice when the owner asked for any music', () => {
    expect(playbackExpectationMatchesRequest(
      'ইউটিউবে একটা মিউজিক বাজাও', 'Coke Studio Bangla',
    )).toBe(true)
    expect(playbackExpectationMatchesRequest('Play anything on YouTube', 'Despacito')).toBe(true)
    expect(playbackExpectationMatchesRequest('Play official audio on YouTube', 'Despacito')).toBe(false)
  })

  it('allows a conservative creator attribution but no unknown content variant', () => {
    expect(mediaSelectionMatchesOwnerRequest(
      'Play Fix You on YouTube',
      'Coldplay - Fix You (Official Video)',
    )).toBe(true)
    expect(mediaSelectionMatchesOwnerRequest(
      'Play Fix You on YouTube',
      'Fix You piano tutorial',
    )).toBe(false)
    expect(mediaSelectionMatchesOwnerRequest(
      'Play Fix You on YouTube',
      'Piano Tutorial - Fix You',
    )).toBe(false)
  })

  it.each([
    ['I want you to play Interstellar on YouTube', 'Interstellar'],
    ['I need you to play Interstellar on YouTube', 'Interstellar'],
    ["I'd like you to put on Interstellar on YouTube", 'Interstellar'],
    ['Boss now pls play Interstellar on YouTube', 'Interstellar'],
    ['আমি একটু ইউটিউবে Interstellar চালাও', 'Interstellar'],
    ['Boss ami YouTube-e Interstellar chalao', 'Interstellar'],
  ])('binds the extracted media title through playback expectation: %s', (request, expectedMedia) => {
    expect(playbackExpectationMatchesRequest(request, expectedMedia)).toBe(true)
  })
})
