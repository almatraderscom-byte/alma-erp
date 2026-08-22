import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  turns: new Map<string, {
    conversationId: string
    userMessageId: string | null
    status: string
    cancelRequested: boolean
    startedAt: Date
    instructionOrigin: 'owner_direct' | 'owner_policy' | null
  }>(),
  messages: new Map<string, {
    id: string
    conversationId: string
    role: string
    createdAt: Date
    content: unknown
    usage?: unknown
  }>(),
  reject: false,
}))

const prismaMock = vi.hoisted(() => ({
  agentTurn: {
    findFirst: vi.fn(async ({ where }: { where: {
      id: string | { not?: string; notIn?: string[] }
      conversationId: string
      startedAt?: { gte: Date }
      OR?: Array<{ instructionOrigin: 'owner_direct' | 'owner_policy' | null }>
    } }) => {
      if (store.reject) throw new Error('database unavailable')
      const idFilter = where.id
      if (typeof idFilter === 'string') {
        const row = store.turns.get(idFilter)
        return row?.conversationId === where.conversationId ? { ...row } : null
      }
      return [...store.turns.entries()]
        .filter(([id, row]) => (
          (!idFilter.not || id !== idFilter.not)
          && (!idFilter.notIn || !idFilter.notIn.includes(id))
          && row.conversationId === where.conversationId
          && (!where.startedAt || row.startedAt.getTime() >= where.startedAt.gte.getTime())
          && (!where.OR || where.OR.some((clause) => row.instructionOrigin === clause.instructionOrigin))
        ))
        .map(([id]) => ({ id }))[0] ?? null
    }),
  },
  agentMessage: {
    findFirst: vi.fn(async ({ where }: {
      where: {
        id: string | { notIn: string[] }
        conversationId: string
        role: string
        createdAt?: { gte: Date }
      }
    }) => {
      if (store.reject) throw new Error('database unavailable')
      const idFilter = where.id
      const rows = typeof idFilter === 'string'
        ? [store.messages.get(idFilter)].filter(Boolean)
        : [...store.messages.values()].filter((row) => !idFilter.notIn.includes(row.id))
      const row = rows.find((candidate) => (
        candidate
        && candidate.conversationId === where.conversationId
        && candidate.role === where.role
        && (!where.createdAt || candidate.createdAt.getTime() >= where.createdAt.gte.getTime())
      ))
      return row ? { id: row.id, createdAt: row.createdAt, content: row.content } : null
    }),
    findMany: vi.fn(async ({ where }: {
      where: {
        conversationId: string
        role: string
        id: { not: string }
        createdAt: { gte: Date }
      }
    }) => {
      if (store.reject) throw new Error('database unavailable')
      return [...store.messages.values()]
        .filter((row) => (
          row.id !== where.id.not
          && row.conversationId === where.conversationId
          && row.role === where.role
          && row.createdAt.getTime() >= where.createdAt.gte.getTime()
        ))
        .map((row) => ({ id: row.id, usage: row.usage ?? null }))
    }),
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import {
  isTurnOwnerContinuationCurrent,
  isTurnOwnerExecutionCurrent,
  loadTurnOwnerInputBinding,
  snapshotTurnHistoryRows,
  turnScopedOwnerInput,
} from '@/agent/lib/live-browser/turn-owner-input'

describe('turn-linked owner input', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.reject = false
    store.turns.clear()
    store.messages.clear()
    store.turns.set('turn-a', {
      conversationId: 'conv-1',
      userMessageId: 'msg-a',
      status: 'running',
      cancelRequested: false,
      startedAt: new Date('2026-08-21T12:00:00.001Z'),
      instructionOrigin: null,
    })
    store.turns.set('turn-b', {
      conversationId: 'conv-1',
      userMessageId: 'msg-b',
      status: 'running',
      cancelRequested: false,
      startedAt: new Date('2026-08-21T12:00:00.002Z'),
      instructionOrigin: null,
    })
    store.messages.set('msg-a', {
      id: 'msg-a',
      conversationId: 'conv-1',
      role: 'user',
      createdAt: new Date('2026-08-21T12:00:00.001Z'),
      content: [{ type: 'text', text: 'Send the invoice tomorrow' }],
    })
    store.messages.set('msg-b', {
      id: 'msg-b',
      conversationId: 'conv-1',
      role: 'user',
      createdAt: new Date('2026-08-21T12:00:00.002Z'),
      content: [
        { type: 'text', text: 'Play Fix You on YouTube' },
        { type: 'ask_card_ref', askCardId: 'device-card-b' },
      ],
    })
  })

  it('keeps a delayed older turn bound to A after newer direct message B is stored', async () => {
    const binding = await loadTurnOwnerInputBinding('conv-1', 'turn-a')
    expect(binding).toEqual({
      state: 'bound',
      messageId: 'msg-a',
      createdAt: new Date('2026-08-21T12:00:00.001Z'),
      text: 'Send the invoice tomorrow',
      askCardId: null,
    })
    expect(turnScopedOwnerInput(binding, 'Play Fix You on YouTube')).toEqual({
      state: 'exact',
      authoritativeText: 'Send the invoice tomorrow',
      askCardId: null,
    })
  })

  it('binds direct authority and card identity only to B linked by B turn', async () => {
    const binding = await loadTurnOwnerInputBinding('conv-1', 'turn-b')
    expect(turnScopedOwnerInput(binding, 'Send the invoice tomorrow')).toEqual({
      state: 'exact',
      authoritativeText: 'Play Fix You on YouTube',
      askCardId: 'device-card-b',
    })
  })

  it('fails closed instead of borrowing the latest direct text when the turn link is unreadable', async () => {
    store.reject = true
    const binding = await loadTurnOwnerInputBinding('conv-1', 'turn-a')
    expect(binding).toEqual({ state: 'unavailable' })
    expect(turnScopedOwnerInput(binding, 'Play Fix You on YouTube')).toEqual({
      state: 'unavailable',
      authoritativeText: '',
      blockerOwnerText: 'Play Fix You on YouTube',
    })
  })

  it('rejects a cross-conversation turn/message mismatch', async () => {
    const binding = await loadTurnOwnerInputBinding('conv-2', 'turn-b')
    expect(binding).toEqual({ state: 'unavailable' })
  })

  it('lets an unbound internal turn keep ordinary text but never inherit browser authority', async () => {
    const binding = await loadTurnOwnerInputBinding('conv-1', null)
    expect(turnScopedOwnerInput(binding, 'Summarize the report')).toEqual({
      state: 'none',
      authoritativeText: 'Summarize the report',
    })
    expect(turnScopedOwnerInput(binding, 'Play Fix You on YouTube')).toEqual({
      state: 'unavailable',
      authoritativeText: '',
      blockerOwnerText: 'Play Fix You on YouTube',
    })
    expect(turnScopedOwnerInput(binding, 'continue')).toEqual({
      state: 'unavailable',
      authoritativeText: '',
      blockerOwnerText: 'continue',
    })
  })

  it('cuts a delayed provider transcript at the exact linked owner message', () => {
    const rows = [
      { id: 'assistant-old', role: 'assistant', createdAt: new Date('2026-08-21T11:59:59.000Z'), content: 'ready' },
      { id: 'msg-a', role: 'user', createdAt: new Date('2026-08-21T12:00:00.001Z'), content: 'Send the invoice tomorrow' },
      { id: 'assistant-a', role: 'assistant', createdAt: new Date('2026-08-21T12:00:00.002Z'), content: 'working' },
      { id: 'msg-b', role: 'user', createdAt: new Date('2026-08-21T12:00:00.003Z'), content: 'Play Fix You on YouTube' },
    ]
    const snapshot = snapshotTurnHistoryRows(rows, {
      state: 'bound',
      messageId: 'msg-a',
      createdAt: new Date('2026-08-21T12:00:00.001Z'),
      text: 'Send the invoice tomorrow',
      askCardId: null,
    })
    expect(snapshot).toEqual({
      state: 'ready',
      rows: rows.slice(0, 2),
      hasLaterRows: true,
    })
    expect(snapshot.rows.some((row) => row.id === 'msg-b')).toBe(false)
  })

  it('fails closed when the linked message is absent from the provider snapshot', () => {
    expect(snapshotTurnHistoryRows(
      [{ id: 'msg-b', role: 'user', createdAt: new Date('2026-08-21T12:00:00.002Z'), content: 'Play Fix You on YouTube' }],
      {
        state: 'bound',
        messageId: 'msg-a',
        createdAt: new Date('2026-08-21T12:00:00.001Z'),
        text: 'Send the invoice tomorrow',
        askCardId: null,
      },
    )).toEqual({ state: 'unavailable', rows: [], hasLaterRows: false })
  })

  it('drops every same-millisecond peer because random UUID order is not causal order', () => {
    const tied = new Date('2026-08-21T12:00:00.001Z')
    const rows = [
      { id: 'older', role: 'assistant', createdAt: new Date('2026-08-21T12:00:00.000Z'), content: 'old' },
      // B sorts before A by random id even though B was inserted later.
      { id: 'a-random-b', role: 'user', createdAt: tied, content: 'Play Fix You on YouTube' },
      { id: 'z-random-a', role: 'user', createdAt: tied, content: 'Send the invoice tomorrow' },
    ]
    expect(snapshotTurnHistoryRows(rows, {
      state: 'bound',
      messageId: 'z-random-a',
      createdAt: tied,
      text: 'Send the invoice tomorrow',
      askCardId: null,
    })).toEqual({
      state: 'ready',
      rows: [rows[0], rows[2]],
      hasLaterRows: true,
    })
  })

  it('revokes an older effect as soon as a newer owner turn is accepted', async () => {
    expect(await isTurnOwnerExecutionCurrent('conv-1', 'turn-a')).toBe(false)
    expect(await isTurnOwnerExecutionCurrent('conv-1', 'turn-b')).toBe(true)
  })

  it('does not let newer unattended policy work revoke the active owner turn', async () => {
    const turnB = store.turns.get('turn-b')!
    turnB.instructionOrigin = 'owner_policy'
    const msgB = store.messages.get('msg-b')!
    msgB.usage = { driverDirective: true }

    expect(await isTurnOwnerExecutionCurrent('conv-1', 'turn-a')).toBe(true)
  })

  it('revokes on the newer durable owner message before its AgentTurn is created', async () => {
    store.turns.delete('turn-b')
    expect(await isTurnOwnerExecutionCurrent('conv-1', 'turn-a')).toBe(false)

    const msgB = store.messages.get('msg-b')!
    msgB.usage = { steering: { targetTurnId: 'turn-a', status: 'queued' } }
    expect(await isTurnOwnerExecutionCurrent('conv-1', 'turn-a')).toBe(true)
  })

  it('accepts only a direct card answer with no intervening owner input', async () => {
    expect(await isTurnOwnerContinuationCurrent('conv-1', 'turn-a', 'turn-b')).toBe(true)

    store.turns.set('turn-c', {
      conversationId: 'conv-1',
      userMessageId: 'msg-c',
      status: 'running',
      cancelRequested: false,
      startedAt: new Date('2026-08-21T12:00:00.003Z'),
      instructionOrigin: null,
    })
    store.messages.set('msg-c', {
      id: 'msg-c',
      conversationId: 'conv-1',
      role: 'user',
      createdAt: new Date('2026-08-21T12:00:00.003Z'),
      content: [
        { type: 'text', text: 'Office Mac Chrome' },
        { type: 'ask_card_ref', askCardId: 'device-card-a' },
      ],
    })
    expect(await isTurnOwnerContinuationCurrent('conv-1', 'turn-a', 'turn-c')).toBe(false)

    store.turns.delete('turn-b')
    store.messages.delete('msg-b')
    expect(await isTurnOwnerContinuationCurrent('conv-1', 'turn-a', 'turn-c')).toBe(true)
  })

  it('fails closed for canceled, missing, equal-time ambiguous, or unavailable turn state', async () => {
    const turnA = store.turns.get('turn-a')!
    store.turns.delete('turn-b')
    store.messages.delete('msg-b')
    expect(await isTurnOwnerExecutionCurrent('conv-1', 'turn-a')).toBe(true)

    turnA.cancelRequested = true
    expect(await isTurnOwnerExecutionCurrent('conv-1', 'turn-a')).toBe(false)
    turnA.cancelRequested = false

    store.turns.set('turn-peer', {
      conversationId: 'conv-1',
      userMessageId: 'msg-peer',
      status: 'running',
      cancelRequested: false,
      startedAt: turnA.startedAt,
      instructionOrigin: null,
    })
    expect(await isTurnOwnerExecutionCurrent('conv-1', 'turn-a')).toBe(false)

    store.reject = true
    expect(await isTurnOwnerExecutionCurrent('conv-1', 'turn-a')).toBe(false)
    expect(await isTurnOwnerExecutionCurrent('conv-1', 'missing')).toBe(false)
  })
})
