import { describe, expect, it } from 'vitest'
import { activeTurnKind, isBackgroundVisibleTurn } from '../active-turns'

describe('activeTurnKind', () => {
  it('classifies the autonomous wake marker as self-wake', () => {
    expect(activeTurnKind('[স্বয়ংক্রিয় হার্টবিট — তুমি নিজে থেকে জেগেছ]', 'web'))
      .toBe('self-wake')
  })

  it('classifies the dedicated heartbeat conversation as self-wake', () => {
    expect(activeTurnKind('', 'heartbeat')).toBe('self-wake')
  })

  it('keeps an ordinary owner turn as active chat', () => {
    expect(activeTurnKind('আজকের অর্ডার চেক করো', 'web')).toBe('active-chat')
  })

  it('never exposes an ordinary foreground owner turn as a background task', () => {
    expect(isBackgroundVisibleTurn({
      id: 'turn-owner',
      conversationId: 'conversation-owner',
      conversationTitle: 'Owner chat',
      kind: 'active-chat',
      input: '২ জনের check-in status দেখো',
      startedAt: new Date().toISOString(),
      updatedAt: null,
    })).toBe(false)
  })

  it('keeps a true autonomous self-wake visible globally', () => {
    expect(isBackgroundVisibleTurn({
      id: 'turn-wake',
      conversationId: 'conversation-heartbeat',
      conversationTitle: 'Heartbeat',
      kind: 'self-wake',
      input: '[স্বয়ংক্রিয় হার্টবিট — তুমি নিজে থেকে জেগেছ]',
      startedAt: new Date().toISOString(),
      updatedAt: null,
    })).toBe(true)
  })
})
