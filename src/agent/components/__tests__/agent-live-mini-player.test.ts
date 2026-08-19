import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentLiveMiniPlayer,
  activityVisibilityKey,
  clampFloatingPosition,
  placementFromPosition,
  positionFromPlacement,
  selectedPreviewPicture,
  shouldExpireLiveActivity,
  snapFloatingPosition,
} from '../AgentLiveDock'

function renderPlayer(screenshot: string | null) {
  return renderToStaticMarkup(
    createElement(AgentLiveMiniPlayer, {
      active: true,
      dotClass: 'bg-emerald-500',
      label: '🌐 পেজ খুলছে',
      screenshot,
      surfaceLabel: 'ব্রাউজার',
      onExpand: vi.fn(),
      onDismiss: vi.fn(),
    }),
  )
}

describe('AgentLiveMiniPlayer', () => {
  it('renders the full live frame directly in the collapsed player', () => {
    const html = renderPlayer('data:image/png;base64,frame')

    expect(html).toContain('data-testid="agent-live-mini-player"')
    expect(html).toContain('alt="এজেন্ট এখন যে স্ক্রিন দেখছে"')
    expect(html).toContain('object-contain')
    expect(html).toContain('লাইভ · ব্রাউজার')
    expect(html).toContain('aria-label="লাইভ ভিউ বড় করে দেখুন"')
    expect(html).toContain('aria-label="বন্ধ করুন"')
  })

  it('keeps a player-shaped placeholder visible until the first frame arrives', () => {
    const html = renderPlayer(null)

    expect(html).toContain('প্রথম ফ্রেম আসছে…')
    expect(html).not.toContain('<img')
  })

  it('keeps multiple Browser contexts and Mac as distinct stacked cards', () => {
    const html = renderToStaticMarkup(
      createElement(AgentLiveMiniPlayer, {
        active: true,
        dotClass: 'bg-emerald-500',
        label: '🌐 পেজ খুলছে',
        screenshot: 'data:image/png;base64,frame',
        surfaceLabel: 'ব্রাউজার',
        onExpand: vi.fn(),
        onDismiss: vi.fn(),
        availablePreviews: [
          { surface: 'browser', contextId: 'browser:chrome-a', labelBn: 'Chrome A' },
          { surface: 'browser', contextId: 'browser:chrome-b', labelBn: 'Chrome B' },
          { surface: 'mac', contextId: 'mac:studio', labelBn: 'Studio Mac' },
        ],
        selectedPreviewId: 'browser:chrome-a',
        onSelectPreview: vi.fn(),
      }),
    )

    expect(html).toContain('data-stack-count="3"')
    expect(html).toContain('aria-label="Chrome A লাইভ ভিউ দেখুন"')
    expect(html).toContain('aria-label="Chrome B লাইভ ভিউ দেখুন"')
    expect(html).toContain('aria-label="Studio Mac লাইভ ভিউ দেখুন"')
    const expandButton = html.indexOf('aria-label="লাইভ ভিউ বড় করে দেখুন"')
    const expandClose = html.indexOf('</button>', expandButton)
    const firstSource = html.indexOf('aria-label="Chrome A লাইভ ভিউ দেখুন"')
    expect(expandClose).toBeLessThan(firstSource)
  })

  it('keeps a nil-current dismissal stable until a genuinely new frame arrives', () => {
    const feed = {
      active: true,
      current: null,
      steps: [],
      screenshot: null,
      screenshotAt: null,
      previews: [{
        surface: 'browser' as const,
        contextId: 'browser:a',
        screenshot: null,
        screenshotAt: '2026-08-19T10:00:00.000Z',
        labelBn: 'Chrome A',
        active: true,
      }],
    }
    const dismissed = activityVisibilityKey(feed)
    expect(activityVisibilityKey({ ...feed })).toBe(dismissed)
    expect(activityVisibilityKey({
      ...feed,
      previews: [{ ...feed.previews[0], screenshotAt: '2026-08-19T10:00:01.000Z' }],
    })).not.toBe(dismissed)
  })

  it('shows a selected context placeholder instead of another source frame', () => {
    expect(selectedPreviewPicture({ screenshot: null }, 'data:image/png;base64,chrome-a')).toBeNull()
    expect(selectedPreviewPicture(null, 'data:image/png;base64,legacy'))
      .toBe('data:image/png;base64,legacy')
  })

  it('expires a frozen active feed after the last successful poll', () => {
    expect(shouldExpireLiveActivity(1_000, 20_999)).toBe(false)
    expect(shouldExpireLiveActivity(1_000, 21_000)).toBe(true)
    expect(shouldExpireLiveActivity(20_999, 21_000, true)).toBe(true)
  })
})

describe('floating PiP geometry', () => {
  const viewport = { width: 390, height: 844 }
  const player = { width: 286, height: 161 }

  it('keeps a dragged player fully inside the visible viewport', () => {
    expect(clampFloatingPosition({ x: -50, y: 900 }, viewport, player)).toEqual({ x: 12, y: 671 })
  })

  it('snaps to the nearest horizontal edge without losing vertical placement', () => {
    expect(snapFloatingPosition({ x: 170, y: 233 }, viewport, player)).toEqual({ x: 92, y: 233 })
    expect(snapFloatingPosition({ x: 20, y: 233 }, viewport, player)).toEqual({ x: 12, y: 233 })
  })

  it('clamps above the measured composer instead of covering it', () => {
    expect(clampFloatingPosition(
      { x: 92, y: 700 },
      { ...viewport, bottomObstacleMinY: 690 },
      player,
    )).toEqual({ x: 92, y: 517 })
  })

  it('preserves the snapped edge and vertical fraction across rotation', () => {
    const portrait = { ...viewport, bottomObstacleMinY: 690 }
    const placement = placementFromPosition({ x: 92, y: 300 }, portrait, player)
    const landscape = positionFromPlacement(
      placement,
      { width: 844, height: 390, bottomObstacleMinY: 340 },
      player,
    )

    expect(placement.edge).toBe('right')
    expect(landscape.x).toBe(546)
    expect(landscape.y + player.height).toBeLessThanOrEqual(328)
  })
})
