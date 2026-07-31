import { describe, expect, it } from 'vitest'
import { projectGlobalOfficePetStatus } from '../pet-status'

describe('projectGlobalOfficePetStatus', () => {
  const now = new Date('2026-07-28T04:00:00.000Z')

  it('clamps counts and emits an explicit empty completion', () => {
    expect(projectGlobalOfficePetStatus({
      runningCount: -3,
      attentionCount: Number.NaN,
      latestCompletion: null,
      now,
    })).toEqual({
      runningCount: 0,
      attentionCount: 0,
      items: [],
      latestCompletion: null,
      updatedAt: now.toISOString(),
    })
  })

  it('projects the stable turn identity used for client-side celebration dedupe', () => {
    const completedAt = new Date('2026-07-28T03:59:30.000Z')
    expect(projectGlobalOfficePetStatus({
      runningCount: 2.9,
      attentionCount: 1,
      latestCompletion: {
        turnId: 'turn-42',
        conversationId: 'conversation-7',
        preview: 'কাজ শেষ হয়েছে Boss।',
        completedAt,
      },
      now,
    })).toEqual({
      runningCount: 2,
      attentionCount: 1,
      items: [],
      latestCompletion: {
        turnId: 'turn-42',
        conversationId: 'conversation-7',
        preview: 'কাজ শেষ হয়েছে Boss।',
        completedAt: completedAt.toISOString(),
      },
      updatedAt: now.toISOString(),
    })
  })

  it('preserves the ordered, explainable companion items', () => {
    const items = [{
      id: 'turn:turn-42',
      turnId: 'turn-42',
      conversationId: 'conversation-7',
      status: 'running' as const,
      title: 'Inventory audit',
      detail: 'Stock data যাচাই করছে',
      updatedAt: now.toISOString(),
      dismissible: false,
    }]
    expect(projectGlobalOfficePetStatus({
      runningCount: 1,
      attentionCount: 0,
      latestCompletion: null,
      items,
      now,
    }).items).toEqual(items)
  })
})
