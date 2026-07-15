import { describe, expect, it } from 'vitest'
import { activeTurnKind } from '../active-turns'

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
})
