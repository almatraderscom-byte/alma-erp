import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentLiveMiniPlayer, clampFloatingPosition, snapFloatingPosition } from '../AgentLiveDock'

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

  it('shows a real stacked surface switcher when Browser and Mac are both available', () => {
    const html = renderToStaticMarkup(
      createElement(AgentLiveMiniPlayer, {
        active: true,
        dotClass: 'bg-emerald-500',
        label: '🌐 পেজ খুলছে',
        screenshot: 'data:image/png;base64,frame',
        surfaceLabel: 'ব্রাউজার',
        onExpand: vi.fn(),
        onDismiss: vi.fn(),
        availableSurfaces: ['browser', 'mac'],
        selectedSurface: 'browser',
        onSelectSurface: vi.fn(),
      }),
    )

    expect(html).toContain('data-stack-count="2"')
    expect(html).toContain('aria-label="ব্রাউজার লাইভ ভিউ দেখুন"')
    expect(html).toContain('aria-label="আপনার Mac লাইভ ভিউ দেখুন"')
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
})
