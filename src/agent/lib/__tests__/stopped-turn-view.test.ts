import { describe, expect, it } from 'vitest'
import { removeStoppedAssistantDraft } from '../stopped-turn-view'

describe('stopped turn view', () => {
  it('removes the optimistic assistant draft and its authority-bearing card', () => {
    const messages = [
      { id: 'u1', role: 'user', text: 'Play Fix You on YouTube' },
      {
        id: 'draft',
        role: 'assistant',
        streaming: true,
        text: 'Fix You is playing',
        askCard: { id: 'unbound-card', options: ['Continue'] },
      },
      { id: 'old', role: 'assistant', streaming: false, text: 'Older durable reply' },
    ]

    expect(removeStoppedAssistantDraft(messages)).toEqual([messages[0], messages[2]])
  })
})
