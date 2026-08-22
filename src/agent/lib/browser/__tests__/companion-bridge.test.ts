import { describe, it, expect, vi } from 'vitest'

const { runCommand, isLiveBrowserEnabled, pickActiveDevice } = vi.hoisted(() => ({
  runCommand: vi.fn(async () => ({ ok: true, status: 'done', commandId: 'cmd-1' })),
  isLiveBrowserEnabled: vi.fn(async () => true),
  pickActiveDevice: vi.fn(async () => ({ id: 'device-1', name: 'Owner Chrome' })),
}))

vi.mock('@/agent/lib/live-browser/companion', () => ({
  runCommand,
  isLiveBrowserEnabled,
  pickActiveDevice,
}))

import { runBrowserTaskOnCompanion, translateStep } from '@/agent/lib/browser/companion-bridge'
import type { BrowserStep } from '@/agent/lib/browser/actions'

/**
 * The translator sits between two step vocabularies, and the dangerous failure is
 * not a crash — it is a step quietly turning into something else, or into nothing.
 * A task that skipped a step and still reported success is worse than one that
 * stopped, so every unsupported case must FAIL rather than degrade.
 */

function ok(step: BrowserStep) {
  const r = translateStep(step)
  if (!r.ok) throw new Error(`expected a translation, got: ${r.error}`)
  return r.command
}

describe('translateStep — the supported vocabulary', () => {
  it('goto becomes navigate', () => {
    expect(ok({ action: 'goto', url: 'https://example.com' })).toEqual({
      action: 'navigate',
      params: { url: 'https://example.com' },
    })
  })

  it('click prefers a selector, and falls back to visible text', () => {
    expect(ok({ action: 'click', selector: '#save' })).toEqual({ action: 'click', params: { selector: '#save' } })
    expect(ok({ action: 'click', text: 'Next page' })).toEqual({ action: 'click', params: { text: 'Next page' } })
  })

  it('type carries the value alongside its target', () => {
    expect(ok({ action: 'type', selector: '#q', value: 'alma' })).toEqual({
      action: 'type',
      params: { selector: '#q', value: 'alma' },
    })
  })

  it('extract splits by what was asked for', () => {
    expect(ok({ action: 'extract' }).action).toBe('read_text')
    expect(ok({ action: 'extract', what: 'html' }).action).toBe('read_dom')
    expect(ok({ action: 'extract', selector: 'main' })).toEqual({ action: 'read_text', params: { selector: 'main' } })
  })

  it('wait uses a selector when given, otherwise a duration', () => {
    expect(ok({ action: 'wait', selector: '.done' })).toEqual({ action: 'wait', params: { selector: '.done' } })
    expect(ok({ action: 'wait', ms: 2500 })).toEqual({ action: 'wait', params: { ms: 2500 } })
  })

  it('press, screenshot and scroll pass through', () => {
    expect(ok({ action: 'press', key: 'Enter' })).toEqual({ action: 'press', params: { key: 'Enter' } })
    expect(ok({ action: 'screenshot' })).toEqual({ action: 'screenshot', params: {} })
    expect(ok({ action: 'scroll', deltaY: 400 })).toEqual({ action: 'scroll', params: { deltaY: 400 } })
  })
})

describe('translateStep — refuses rather than degrades', () => {
  it.each(['click_xy', 'double_click', 'move', 'drag', 'zoom'] as const)(
    'refuses the coordinate verb %s, because the owner\'s window is not a fixed viewport',
    (action) => {
      const r = translateStep({ action, x: 10, y: 10, toX: 20, toY: 20, region: { x: 0, y: 0, width: 5, height: 5 } })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(action)
    },
  )

  it('refuses an incomplete step instead of sending a half-command', () => {
    expect(translateStep({ action: 'goto' }).ok).toBe(false)
    expect(translateStep({ action: 'click' }).ok).toBe(false)
    expect(translateStep({ action: 'type', selector: '#q' }).ok).toBe(false)
    expect(translateStep({ action: 'type', value: 'x' }).ok).toBe(false)
    expect(translateStep({ action: 'press' }).ok).toBe(false)
  })
})

describe('translateStep — the final-submit ban survives the translation', () => {
  it.each(['Send', 'Pay now', 'Confirm order', 'Publish', 'পাঠান'])('refuses to queue a click on "%s"', (label) => {
    const r = translateStep({ action: 'click', text: label })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('owner')
  })

  it('still allows an ordinary click that merely contains an innocent word', () => {
    expect(translateStep({ action: 'click', text: 'Search results' }).ok).toBe(true)
  })
})

describe('worker-backed Companion execution authority', () => {
  it('persists the exact approved task turn/conversation on every command', async () => {
    const activityContext = { turnId: 'turn-approved-1', conversationId: 'conversation-1' }
    const result = await runBrowserTaskOnCompanion({
      goal: 'Read the approved page',
      conversationId: 'conversation-1',
      steps: [{ action: 'goto', url: 'https://example.com' }],
      driver: 'companion',
    }, activityContext)

    expect(result.ok).toBe(true)
    expect(runCommand).toHaveBeenCalledWith(
      'device-1',
      'navigate',
      { url: 'https://example.com' },
      undefined,
      activityContext,
    )
  })
})
