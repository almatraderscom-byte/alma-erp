import { describe, expect, it } from 'vitest'
import {
  activityFeedIsActive,
  browserPreviewId,
  flattenBrowserDeviceRows,
  heldPreviewAt,
  isResolvedLiveActivityOwner,
  parsePreviewAfter,
  projectMacPreviews,
  singleMacPreviewVideoDeviceId,
} from '../route'

describe('live-activity preview deck helpers', () => {
  it('gives every paired Chrome context its own stable card identity', () => {
    expect(browserPreviewId('chrome-a')).toBe('browser:chrome-a')
    expect(browserPreviewId('chrome-b')).toBe('browser:chrome-b')
    expect(browserPreviewId('chrome-a')).not.toBe(browserPreviewId('chrome-b'))
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
