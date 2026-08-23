import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '@/agent/components/AgentThread'
import {
  markTimelinePreamble,
  supersedeLatestTimelineDraft,
} from '@/agent/components/agent-timeline'

describe('live agent timeline verification replacement', () => {
  it('supersedes entry zero when the turn had no preamble', () => {
    const timeline: TimelineEntry[] = [{ t: 'text', text: 'raw order AL-42' }]

    expect(supersedeLatestTimelineDraft(timeline)).toEqual([
      { t: 'text', text: 'raw order AL-42', state: 'superseded' },
    ])
  })

  it('preserves only the explicitly marked preamble and supersedes the later draft', () => {
    const marked = markTimelinePreamble(
      [{ t: 'text', text: 'বস, দেখছি।' }],
      'বস, দেখছি।',
    )
    const timeline: TimelineEntry[] = [
      ...marked,
      { t: 'tool', id: 'tool-1', name: 'get_orders', ok: true },
      { t: 'text', text: 'raw order AL-42' },
    ]

    expect(supersedeLatestTimelineDraft(timeline)).toEqual([
      { t: 'text', text: 'বস, দেখছি।', lead: true },
      { t: 'tool', id: 'tool-1', name: 'get_orders', ok: true },
      { t: 'text', text: 'raw order AL-42', state: 'superseded' },
    ])
  })
})
