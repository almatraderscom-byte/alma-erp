import { describe, expect, it } from 'vitest'
import {
  supersedeVerificationTimeline,
  verificationRetryBaseText,
} from '@/agent/lib/verification-retry-view'

describe('verification retry hard replacement', () => {
  it('drops an unsupported playback preamble from non-stream output', () => {
    expect(verificationRetryBaseText(
      'Done — the song is playing.',
      ['media_playback_unverified'],
    )).toBe('')
    expect(verificationRetryBaseText('আমি দেখে নিচ্ছি', ['tool_not_called']))
      .toBe('আমি দেখে নিচ্ছি\n\n')
  })

  it('supersedes every live text segment for an unverified playback claim', () => {
    const timeline = supersedeVerificationTimeline([
      { t: 'text', text: 'Done — the song is playing.' },
      { t: 'tool', name: 'live_browser_act' },
      { t: 'text', text: 'Enjoy.' },
    ], ['media_playback_unverified'])
    expect(timeline.filter((entry) => entry.t === 'text')).toEqual([
      { t: 'text', text: 'Done — the song is playing.', state: 'superseded' },
      { t: 'text', text: 'Enjoy.', state: 'superseded' },
    ])
  })

  it('preserves the leading preamble for ordinary self-correction', () => {
    expect(supersedeVerificationTimeline([
      { t: 'text', text: 'আমি কাজটা দেখছি।' },
      { t: 'text', text: 'unverified draft' },
    ], ['tool_not_called'])).toEqual([
      { t: 'text', text: 'আমি কাজটা দেখছি।' },
      { t: 'text', text: 'unverified draft', state: 'superseded' },
    ])
  })
})
