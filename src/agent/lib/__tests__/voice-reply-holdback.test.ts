import { describe, expect, it } from 'vitest'
import {
  DIRECT_YOUTUBE_VOICE_INTERRUPTION_BLOCKER,
  flushHeldVoiceReply,
  reduceHeldVoiceReply,
  settleHeldVoiceReply,
} from '@/agent/lib/voice-reply-holdback'

describe('voice reply holdback', () => {
  it('never releases an unverified playback draft to TTS', () => {
    let state = reduceHeldVoiceReply(
      { text: '' },
      { type: 'text_delta', delta: 'Done — the song is playing.' },
    )
    // No flush occurs while the turn is live, so this text is not speakable.
    expect(state.text).toContain('playing')

    state = reduceHeldVoiceReply(state, {
      type: 'verification_retry',
      categories: ['media_playback_unverified'],
    })
    state = reduceHeldVoiceReply(state, {
      type: 'text_delta',
      delta: 'Playback যাচাই হয়নি, তাই চলছে বলে দাবি করছি না।',
    })
    const spoken = flushHeldVoiceReply(state)
    expect(spoken).toBe('Playback যাচাই হয়নি, তাই চলছে বলে দাবি করছি না।')
    expect(spoken).not.toContain('Done')
  })

  it('discards a direct YouTube draft when transport reaches EOF before parsed done', () => {
    let state = reduceHeldVoiceReply(
      { text: '' },
      { type: 'text_delta', delta: 'Done — Fix You is playing now.' },
    )
    state = reduceHeldVoiceReply(state, { type: 'transport_end' })

    const returned = settleHeldVoiceReply(state, { requireAuthoritativeDone: true })
    const spoken: string[] = []
    if (returned) spoken.push(returned)

    expect(returned).toBe(DIRECT_YOUTUBE_VOICE_INTERRUPTION_BLOCKER)
    expect(returned).not.toContain('Fix You')
    expect(spoken).toEqual([DIRECT_YOUTUBE_VOICE_INTERRUPTION_BLOCKER])
  })

  it('flushes a direct YouTube draft only after parsed done', () => {
    let state = reduceHeldVoiceReply(
      { text: '' },
      { type: 'text_delta', delta: 'YouTube playback verified.' },
    )
    state = reduceHeldVoiceReply(state, { type: 'done' })
    state = reduceHeldVoiceReply(state, { type: 'transport_end' })

    const returned = settleHeldVoiceReply(state, { requireAuthoritativeDone: true })
    const spoken: string[] = []
    if (returned) spoken.push(returned)

    expect(returned).toBe('YouTube playback verified.')
    expect(spoken).toEqual(['YouTube playback verified.'])
  })

  it('does not let a later done revive a draft after an error happened first', () => {
    let state = reduceHeldVoiceReply(
      { text: '' },
      { type: 'text_delta', delta: 'The song is playing.' },
    )
    state = reduceHeldVoiceReply(state, { type: 'transport_error' })
    state = reduceHeldVoiceReply(state, { type: 'done' })

    expect(settleHeldVoiceReply(state, { requireAuthoritativeDone: true }))
      .toBe(DIRECT_YOUTUBE_VOICE_INTERRUPTION_BLOCKER)
  })

  it('also discards a short continuation/non-direct-looking draft before done', () => {
    let state = reduceHeldVoiceReply(
      { text: '' },
      { type: 'text_delta', delta: 'Continue succeeded; the song is playing.' },
    )
    state = reduceHeldVoiceReply(state, { type: 'transport_end' })
    expect(settleHeldVoiceReply(state, { requireAuthoritativeDone: true }))
      .toBe(DIRECT_YOUTUBE_VOICE_INTERRUPTION_BLOCKER)
    expect(settleHeldVoiceReply(state, { requireAuthoritativeDone: true }))
      .not.toContain('song is playing')
  })
})
