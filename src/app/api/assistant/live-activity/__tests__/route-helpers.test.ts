import { describe, expect, it } from 'vitest'
import {
  activityFeedIsActive,
  activityAllowsVideoIdentity,
  activityCommandBinding,
  boundPreviewSourceState,
  browserPreviewId,
  effectiveBrowserTabContext,
  flattenBrowserDeviceRows,
  heldPreviewAt,
  isResolvedLiveActivityOwner,
  macVideoStampIsActive,
  parsePreviewAfter,
  projectMacPreviews,
  sameMacFrameActivity,
  singleMacPreviewVideoDeviceId,
} from '../route'

describe('live-activity preview deck helpers', () => {
  it('gives every paired Chrome context its own stable card identity', () => {
    expect(browserPreviewId('chrome-a')).toBe('browser:chrome-a')
    expect(browserPreviewId('chrome-a', 'tab:42')).toBe('browser:chrome-a:tab:42')
    expect(browserPreviewId('chrome-b')).toBe('browser:chrome-b')
    expect(browserPreviewId('chrome-a')).not.toBe(browserPreviewId('chrome-b'))
  })

  it('merges an unresolved command into the freshest real tab card', () => {
    expect(effectiveBrowserTabContext(null, 'tab:42')).toBe('tab:42')
    expect(effectiveBrowserTabContext('tab:7', 'tab:42')).toBe('tab:7')
    expect(effectiveBrowserTabContext(null, null)).toBeNull()
  })

  it('keeps a bound source alive between frames for the whole running turn', () => {
    expect(boundPreviewSourceState({ turnStatus: 'running', hasSource: true, hasFreshFrame: false }))
      .toBe('between_steps')
    expect(boundPreviewSourceState({ turnStatus: 'running', hasSource: true, hasFreshFrame: true }))
      .toBe('live')
    expect(boundPreviewSourceState({ turnStatus: 'done', hasSource: true, hasFreshFrame: true }))
      .toBe('done')
    expect(boundPreviewSourceState({ turnStatus: 'error', hasSource: true, hasFreshFrame: false }))
      .toBe('failed')
  })

  it('scopes command/frame lookup only when both exact activity ids are present', () => {
    expect(activityCommandBinding('turn-1', 'conv-1')).toEqual({
      turnId: 'turn-1', conversationId: 'conv-1',
    })
    expect(activityCommandBinding('turn-1', null)).toEqual({
      turnId: null, conversationId: null,
    })
    expect(activityCommandBinding(null, null)).toEqual({
      turnId: null, conversationId: null,
    })
  })

  it('accepts only bounded string timestamps from the conditional-frame map', () => {
    expect(parsePreviewAfter(JSON.stringify({
      'browser:a': '2026-08-19T10:00:00.000Z',
      'browser:b': 42,
      nested: { at: 'nope' },
    }))).toEqual({ 'browser:a': '2026-08-19T10:00:00.000Z' })
    expect(parsePreviewAfter('{broken')).toEqual({})
    expect(parsePreviewAfter('x'.repeat(10_001))).toEqual({})
  })

  it('treats a missing key in a supplied context map as never cached', () => {
    const cached = { 'browser:a': '2026-08-19T10:00:10.000Z' }
    expect(heldPreviewAt(cached, true, 'browser:b', '2026-08-19T10:00:10.000Z')).toBeNull()
    expect(heldPreviewAt({}, false, 'browser:b', '2026-08-19T10:00:10.000Z'))
      .toBe('2026-08-19T10:00:10.000Z')
  })

  it('keeps a quieter Chrome context when another device has twelve newer actions', () => {
    const commands = Array.from({ length: 12 }, (_, index) => ({
      id: `a-${index}`,
      action: 'click',
      params: null,
      status: 'done',
      createdAt: new Date(`2026-08-19T10:00:${String(59 - index).padStart(2, '0')}.000Z`),
    }))
    const rows = flattenBrowserDeviceRows([
      { id: 'chrome-a', name: 'Chrome A', commands },
      {
        id: 'chrome-b',
        name: 'Chrome B',
        commands: [{
          id: 'b-shot',
          action: 'screenshot',
          params: null,
          status: 'done',
          createdAt: new Date('2026-08-19T09:59:59.000Z'),
        }],
      },
    ])

    expect(rows.filter((row) => row.deviceId === 'chrome-a')).toHaveLength(12)
    expect(rows.find((row) => row.deviceId === 'chrome-b')?.device?.name).toBe('Chrome B')
  })

  it('does not grant founder device frames to a different SUPER_ADMIN id', () => {
    expect(isResolvedLiveActivityOwner('founder', ['founder'])).toBe(true)
    expect(isResolvedLiveActivityOwner('second-admin', ['founder'])).toBe(false)
  })

  it('never attaches one Mac broadcaster to another Mac screenshot card', () => {
    const previews = projectMacPreviews([
      {
        deviceId: 'mac-a',
        screenshot: 'data:image/jpeg;base64,AAA',
        screenshotAt: '2026-08-19T10:00:30.000Z',
        labelBn: 'Mac A',
        active: true,
        videoActive: false,
      },
      {
        deviceId: 'mac-b',
        screenshot: 'data:image/jpeg;base64,BBB',
        screenshotAt: '2026-08-19T10:00:20.000Z',
        labelBn: 'Mac B',
        active: true,
        videoActive: true,
      },
    ])

    expect(previews).toEqual([
      expect.objectContaining({ contextId: 'mac:mac-a', screenshot: expect.stringContaining('AAA'), videoDeviceId: null }),
      expect.objectContaining({ contextId: 'mac:mac-b', screenshot: expect.stringContaining('BBB'), videoDeviceId: 'mac-b' }),
    ])
    expect(singleMacPreviewVideoDeviceId(previews)).toBeNull()
    expect(singleMacPreviewVideoDeviceId([previews[1]])).toBe('mac-b')
  })

  it('never relabels prior-turn Mac pixels or RTC heartbeat as the requested turn', () => {
    expect(sameMacFrameActivity(
      { turnId: 'turn-a', conversationId: 'conv-1' },
      'turn-b',
      'conv-1',
    )).toBe(false)
    expect(sameMacFrameActivity(
      { turnId: 'turn-b', conversationId: 'conv-1' },
      'turn-b',
      'conv-1',
    )).toBe(true)

    const now = Date.parse('2026-08-19T10:00:05.000Z')
    const stampA = JSON.stringify({
      at: '2026-08-19T10:00:04.000Z',
      turnId: 'turn-a',
      conversationId: 'conv-1',
    })
    expect(macVideoStampIsActive(stampA, 'turn-b', 'conv-1', now)).toBe(false)
    expect(macVideoStampIsActive(stampA, 'turn-a', 'conv-1', now)).toBe(true)
    expect(macVideoStampIsActive('2026-08-19T10:00:04.000Z', 'turn-a', 'conv-1', now))
      .toBe(false)
  })

  it('keeps bound pixels and RTC out of legacy unscoped clients', () => {
    expect(sameMacFrameActivity(
      { turnId: 'turn-a', conversationId: 'conv-1' },
      null,
      null,
    )).toBe(false)
    expect(sameMacFrameActivity(
      { turnId: null, conversationId: null },
      null,
      null,
    )).toBe(true)
    const now = Date.parse('2026-08-19T10:00:05.000Z')
    expect(macVideoStampIsActive(JSON.stringify({
      at: '2026-08-19T10:00:04.000Z',
      turnId: 'turn-a',
      conversationId: 'conv-1',
    }), null, null, now)).toBe(false)
    expect(macVideoStampIsActive('2026-08-19T10:00:04.000Z', null, null, now)).toBe(true)
  })

  it('never advertises RTC/video identity for a terminal or missing bound turn', () => {
    expect(activityAllowsVideoIdentity(true, 'running')).toBe(true)
    expect(activityAllowsVideoIdentity(true, 'done')).toBe(false)
    expect(activityAllowsVideoIdentity(true, 'error')).toBe(false)
    expect(activityAllowsVideoIdentity(true, null)).toBe(false)
    expect(activityAllowsVideoIdentity(false, null)).toBe(true)
  })

  it('keeps the feed active when a quiet source preview survives global step trimming', () => {
    expect(activityFeedIsActive({
      runningCount: 0,
      justFinishedCount: 0,
      previews: [{
        surface: 'mac',
        contextId: 'mac:quiet',
        screenshot: null,
        screenshotAt: null,
        labelBn: 'Quiet Mac',
        active: true,
        videoDeviceId: null,
      }],
      freshMacFrameCount: 0,
    })).toBe(true)
  })
})
