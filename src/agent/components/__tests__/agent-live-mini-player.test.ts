import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentLiveMiniPlayer } from '../AgentLiveDock'

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
})
