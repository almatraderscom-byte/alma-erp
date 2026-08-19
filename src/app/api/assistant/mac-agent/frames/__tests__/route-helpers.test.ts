import { describe, expect, it } from 'vitest'
import {
  inferMacFrameScope,
  inferProducerMacFrameScope,
  macFrameScopeCanPublish,
} from '../route'

const createdAt = new Date('2026-08-19T10:00:00.000Z')

describe('Mac frame stream ownership', () => {
  it('binds a legacy inferred scope only after the start is confirmed done', () => {
    expect(inferMacFrameScope({
      status: 'done',
      params: { mode: 'start', reason: 'computer_use' },
      turnId: 'turn-b',
      conversationId: 'conv-1',
      deliveredAt: new Date('2026-08-19T10:00:01.000Z'),
      resolvedAt: null,
      createdAt,
    })).toMatchObject({
      active: true,
      pending: false,
      turnId: 'turn-b',
      conversationId: 'conv-1',
    })
  })

  it('does not resurrect an older activity after the newest stream command stops', () => {
    expect(inferMacFrameScope({
      status: 'done',
      params: { mode: 'stop', reason: 'computer_use' },
      turnId: 'turn-a',
      conversationId: 'conv-1',
      deliveredAt: new Date('2026-08-19T10:00:02.000Z'),
      resolvedAt: null,
      createdAt,
    })).toEqual({
      active: false,
      turnId: null,
      conversationId: null,
      startedAt: null,
      pending: false,
    })
  })

  it('does not advance scope for a merely delivered start whose poll response may be lost', () => {
    expect(inferMacFrameScope({
      status: 'delivered',
      params: { mode: 'start', reason: 'computer_use' },
      turnId: 'turn-b',
      conversationId: 'conv-1',
      deliveredAt: new Date('2026-08-19T10:00:01.000Z'),
      resolvedAt: null,
      createdAt,
    })).toEqual({
      active: false,
      pending: true,
      turnId: null,
      conversationId: null,
      startedAt: null,
    })
  })

  it('accepts a delivered start only with exact daemon execution proof', () => {
    const row = {
      status: 'delivered',
      params: { mode: 'start', reason: 'computer_use' },
      turnId: 'turn-b',
      conversationId: 'conv-1',
      deliveredAt: new Date('2026-08-19T10:00:01.000Z'),
      resolvedAt: null,
      createdAt,
    }
    expect(inferProducerMacFrameScope(row, {
      streamCommandId: 'command-b',
      turnId: 'turn-b',
      conversationId: 'conv-1',
    })).toMatchObject({ active: true, turnId: 'turn-b', conversationId: 'conv-1' })
    expect(inferProducerMacFrameScope(row, {
      streamCommandId: 'command-a',
      turnId: 'turn-a',
      conversationId: 'conv-1',
    })).toBeNull()
    expect(inferProducerMacFrameScope(row, {
      streamCommandId: 'command-b',
      turnId: 'turn-b',
      conversationId: 'conv-1',
    }, new Date('2026-08-19T10:00:02.000Z'))).toBeNull()
  })

  it('halts bound capture as soon as its exact turn is no longer running', () => {
    const bound = {
      active: true,
      turnId: 'turn-a',
      conversationId: 'conv-1',
    }
    expect(macFrameScopeCanPublish(bound, true)).toBe(true)
    expect(macFrameScopeCanPublish(bound, false)).toBe(false)
    expect(macFrameScopeCanPublish({ active: true, turnId: null, conversationId: null }, false))
      .toBe(true)
  })
})
