import { describe, expect, it } from 'vitest'
import {
  BROWSER_PLAYBACK_VERIFIED_OUTPUT_UNCHECKED,
  buildVerificationReminder,
  detectUnverifiedMediaPlayback,
  hardGateMediaPlaybackFinalText,
  mediaPlaybackGateAuthorizesCompletion,
} from '@/agent/lib/claim-verifier'

const OWNER = 'Play Coke Studio Bangla on YouTube'

function record(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    toolName: 'live_browser_look',
    status: 'success' as const,
    output: {
      data: {
        device: 'My Mac Chrome',
        deviceId: 'device-mac-1',
        currentUrl: 'https://www.youtube.com/watch?v=abc',
        observationReceipt: 'receipt-1',
        observationIssuedAt: new Date(now - 1_000).toISOString(),
        observationExpiresAt: new Date(now + 30_000).toISOString(),
        playbackVerification: {
          verified: true,
          expectedMedia: 'Coke Studio Bangla',
          expectedHost: 'youtube.com',
          playbackObservedAt: new Date(now - 1_100).toISOString(),
          reasons: [],
        },
        ...overrides,
      },
    },
  }
}

describe('YouTube playback claim proof', () => {
  it('rejects completion backed only by a click/screenshot, regardless of wording', () => {
    for (const reply of [
      'Boss, গানটা এখন চলছে।',
      'Done — enjoy the song.',
      'I played it.',
      'গানটা বাজছে, শুনুন।',
    ]) {
      const violations = detectUnverifiedMediaPlayback(
        'ইউটিউবে Coke Studio Bangla গানটা চালাও',
        reply,
        [{ toolName: 'live_browser_act', status: 'success', output: { data: { ok: true } } }],
      )
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatchObject({
        category: 'media_playback_unverified',
        ruleId: 'youtube_playback_requires_advancing_clock',
      })
      expect(buildVerificationReminder(violations)).toContain('playbackVerification.verified=true')
    }
  })

  it('accepts only a latest successful look bound to query, host, device and receipt', () => {
    expect(detectUnverifiedMediaPlayback(OWNER, 'It is playing now.', [record()])).toEqual([])

    const wrongQuery = record({
      playbackVerification: {
        verified: true,
        expectedMedia: 'Taylor Swift Blank Space',
        expectedHost: 'youtube.com',
        playbackObservedAt: new Date(Date.now() - 1_100).toISOString(),
        reasons: [],
      },
    })
    expect(detectUnverifiedMediaPlayback(OWNER, 'Done — enjoy.', [wrongQuery])).toHaveLength(1)
    expect(detectUnverifiedMediaPlayback(OWNER, 'Done — enjoy.', [record({ observationReceipt: undefined })])).toHaveLength(1)
    expect(detectUnverifiedMediaPlayback(OWNER, 'Done — enjoy.', [record({ deviceId: undefined })])).toHaveLength(1)
    expect(detectUnverifiedMediaPlayback(OWNER, 'Done — enjoy.', [record({ currentUrl: 'https://example.com' })])).toHaveLength(1)
  })

  it('requires a fresh, unexpired server observation lease', () => {
    const now = Date.now()
    expect(detectUnverifiedMediaPlayback(OWNER, 'It is playing now.', [record({
      // Receipt is fresh, but the actual second media-clock sample is stale.
      playbackVerification: {
        verified: true,
        expectedMedia: 'Coke Studio Bangla',
        expectedHost: 'youtube.com',
        playbackObservedAt: new Date(now - 16_000).toISOString(),
        reasons: [],
      },
    })])).toHaveLength(1)
    expect(detectUnverifiedMediaPlayback(OWNER, 'It is playing now.', [record({
      observationIssuedAt: new Date(now - 1_000).toISOString(),
      observationExpiresAt: new Date(now - 1).toISOString(),
    })])).toHaveLength(1)
    expect(detectUnverifiedMediaPlayback(OWNER, 'It is playing now.', [record({
      observationIssuedAt: undefined,
    })])).toHaveLength(1)
    expect(detectUnverifiedMediaPlayback(OWNER, 'It is playing now.', [record({
      playbackVerification: {
        verified: true,
        expectedMedia: 'Coke Studio Bangla',
        expectedHost: 'youtube.com',
        playbackObservedAt: undefined,
        reasons: [],
      },
    })])).toHaveLength(1)
  })

  it('binds final playback proof to the same immutable device as the act', () => {
    const act = (deviceId: string) => ({
      toolName: 'live_browser_act',
      status: 'success' as const,
      output: { data: { device: 'My Mac Chrome', deviceId, action: 'click' } },
    })
    expect(detectUnverifiedMediaPlayback(OWNER, 'It is playing now.', [
      act('device-mac-1'),
      record(),
    ])).toEqual([])
    expect(detectUnverifiedMediaPlayback(OWNER, 'It is playing now.', [
      act('different-device'),
      record(),
    ])).toHaveLength(1)
  })

  it('invalidates an earlier verified proof when a later browser act or look changed state', () => {
    expect(detectUnverifiedMediaPlayback(OWNER, 'It is playing now.', [
      record(),
      { toolName: 'live_browser_act', status: 'success' as const, output: { data: { action: 'press' } } },
    ])).toHaveLength(1)
    expect(detectUnverifiedMediaPlayback(OWNER, 'It is playing now.', [
      record(),
      record({ playbackVerification: { verified: false, reasons: ['media_not_playing'] } }),
    ])).toHaveLength(1)
  })

  it('does not let a past negative phrase hide a current success claim', () => {
    expect(detectUnverifiedMediaPlayback(
      OWNER,
      'It was not playing before, but it is playing now.',
      [],
    )).toHaveLength(1)
  })

  it('allows an honest current blocker and a search-only task', () => {
    expect(detectUnverifiedMediaPlayback(
      'ইউটিউবে গানটা চালাও',
      'Player দেখা গেছে, কিন্তু এখন চলছে না—verification হয়নি।',
      [],
    )).toEqual([])
    expect(detectUnverifiedMediaPlayback(
      'Search YouTube for ALMA',
      'Search results are showing.',
      [],
    )).toEqual([])
  })

  it('hard-replaces unsupported completion after retries/deadline', () => {
    const blocked = hardGateMediaPlaybackFinalText(OWNER, 'Done — enjoy.', [])
    expect(blocked.replaced).toBe(true)
    expect(blocked.text).toContain('দাবি করছি না')

    const mixed = hardGateMediaPlaybackFinalText(
      OWNER,
      'যাচাই হয়নি, তবে ঠিক গানটাই এখন শোনা যাচ্ছে।',
      [],
    )
    expect(mixed.replaced).toBe(true)
    expect(mixed.text).not.toContain('শোনা যাচ্ছে')

    const honestButModelAuthored = hardGateMediaPlaybackFinalText(
      OWNER,
      'Player দেখা গেছে, কিন্তু এখন চলছে না—verification হয়নি।',
      [],
    )
    expect(honestButModelAuthored.replaced).toBe(true)

    const proved = hardGateMediaPlaybackFinalText(
      OWNER,
      'It is playing now and you can hear it.',
      [record()],
    )
    expect(proved).toMatchObject({
      text: BROWSER_PLAYBACK_VERIFIED_OUTPUT_UNCHECKED,
      replaced: true,
      playbackRequested: true,
      browserPlaybackVerified: true,
    })
    expect(proved.text).not.toContain('you can hear it')
    expect(proved.text).toContain('macOS system/output-device')
    expect(proved.text).toContain('দাবি করছি না')
    expect(mediaPlaybackGateAuthorizesCompletion(proved)).toBe(true)
    expect(mediaPlaybackGateAuthorizesCompletion(blocked)).toBe(false)
  })

  it('hard-gates a playback command even when strict direct routing misses its grammar', () => {
    const owner = 'Please try playing Fix You on YouTube'
    expect(detectUnverifiedMediaPlayback(owner, "It's playing now.", [])).toHaveLength(1)
    expect(hardGateMediaPlaybackFinalText(owner, "It's playing now.", [])).toMatchObject({
      replaced: true,
      playbackRequested: true,
      browserPlaybackVerified: false,
    })
  })
})
