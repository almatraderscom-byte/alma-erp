import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  cards: new Map<string, Record<string, unknown>>(),
  turns: new Map<string, Record<string, unknown>>(),
  liveBrowserEnabled: true,
  dispatchBoundary: null as string | null,
}))

const ownerFence = vi.hoisted(() => ({
  executionCurrent: vi.fn(async () => true),
  continuationCurrent: vi.fn(async () => true),
}))

const defaultTurn = vi.hoisted(() => (id: string, conversationId: string = 'conv-1') => {
  const numeric = Number(id.match(/(\d+)$/)?.[1] ?? 100)
  return {
    id,
    conversationId,
    status: 'running',
    cancelRequested: false,
    startedAt: new Date(Date.parse('2026-08-21T09:00:00.000Z') + numeric * 1000),
  }
})

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(async (_query?: unknown) => [{ locked: true }]),
  $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock)),
  agentTurn: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
      ...(store.turns.get(where.id) ?? defaultTurn(where.id)),
    })),
  },
  agentKvSetting: {
    findUnique: vi.fn(async ({ where }: { where: { key: string } }) => ({
      value: where.key === 'live_browser_enabled'
        ? String(store.liveBrowserEnabled)
        : store.dispatchBoundary,
    })),
  },
  agentConversationFocus: {
    findUnique: vi.fn(async () => store.row ? { ...store.row } : null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (store.row) throw Object.assign(new Error('unique'), { code: 'P2002' })
      store.row = {
        ...data,
        version: 1,
        leaseUntil: data.leaseUntil,
      }
      return { ...store.row }
    }),
    updateMany: vi.fn(async ({ where, data }: {
      where: { id: string; version: number }
      data: Record<string, unknown>
    }) => {
      if (!store.row || store.row.id !== where.id || store.row.version !== where.version) {
        return { count: 0 }
      }
      store.row = { ...store.row, ...data }
      return { count: 1 }
    }),
  },
  agentAskCard: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (
      store.cards.get(where.id) ? { ...store.cards.get(where.id)! } : null
    )),
    updateMany: vi.fn(async ({ where, data }: {
      where: { id: string | { in: string[] }; conversationId?: string; status?: { in?: string[] } }
      data: Record<string, unknown>
    }) => {
      const ids = typeof where.id === 'string' ? [where.id] : where.id.in
      let count = 0
      for (const id of ids) {
        const card = store.cards.get(id)
        if (!card) continue
        if (where.conversationId && card.conversationId !== where.conversationId) continue
        if (where.status?.in && !where.status.in.includes(String(card.status))) continue
        store.cards.set(id, { ...card, ...data })
        count++
      }
      return { count }
    }),
  },
  agentFocusEvent: { create: vi.fn(async () => ({})) },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('../turn-owner-input', () => ({
  isTurnOwnerExecutionCurrent: ownerFence.executionCurrent,
  isTurnOwnerContinuationCurrent: ownerFence.continuationCurrent,
}))

import {
  bindDirectYouTubeAskCard,
  bindDirectYouTubeSelectedMedia,
  bindDirectYouTubeSoleDevice,
  DIRECT_YOUTUBE_LANE_MAX_LEASE_MS,
  DIRECT_YOUTUBE_ROUTE_MISS_BLOCKER,
  DIRECT_YOUTUBE_LANE_SETTLEMENT_BLOCKER,
  DIRECT_YOUTUBE_LANE_UNAVAILABLE_TOOL_NAMES,
  hardGateUnavailableDirectYouTubeLane,
  getDirectYouTubeDeviceSelection,
  getDirectYouTubeSelectedMedia,
  isDirectBrowserContinuationText,
  isDirectYouTubeTurnLaneCurrent,
  reserveDirectYouTubeAskCard,
  resolveDirectYouTubeTurnRequest,
  runDirectYouTubeOwnerFencedEffect,
  revokeDirectYouTubeTurnLaneForSteering,
  settleDirectYouTubeTurnLane,
  stageDirectYouTubeDeviceOptions,
  supersedeDirectYouTubeAskCards,
} from '../turn-lane'

const REQUEST = 'Play Fix You by Coldplay on YouTube'
const NOW = new Date('2026-08-21T10:00:00.000Z')

describe('durable direct YouTube turn lane', () => {
  beforeEach(() => {
    store.row = null
    store.cards.clear()
    store.turns.clear()
    store.liveBrowserEnabled = true
    store.dispatchBoundary = null
    vi.clearAllMocks()
    prismaMock.$queryRaw.mockReset().mockResolvedValue([{ locked: true }])
    prismaMock.$transaction.mockReset()
      .mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock))
    ownerFence.executionCurrent.mockReset().mockResolvedValue(true)
    ownerFence.continuationCurrent.mockReset().mockResolvedValue(true)
    prismaMock.agentTurn.findUnique.mockReset()
      .mockImplementation(async ({ where }: { where: { id: string } }) => ({
        ...(store.turns.get(where.id) ?? defaultTurn(where.id)),
      }))
    prismaMock.agentConversationFocus.findUnique.mockReset()
      .mockImplementation(async () => store.row ? { ...store.row } : null)
    prismaMock.agentConversationFocus.create.mockReset()
      .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        if (store.row) throw Object.assign(new Error('unique'), { code: 'P2002' })
        store.row = { ...data, version: 1, leaseUntil: data.leaseUntil }
        return { ...store.row }
      })
    prismaMock.agentConversationFocus.updateMany.mockReset()
      .mockImplementation(async ({ where, data }: {
        where: { id: string; version: number }
        data: Record<string, unknown>
      }) => {
        if (!store.row || store.row.id !== where.id || store.row.version !== where.version) {
          return { count: 0 }
        }
        store.row = { ...store.row, ...data }
        return { count: 1 }
      })
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  it('casts every advisory-lock result before Prisma deserializes it', async () => {
    const lane = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    expect(lane?.state).toBe('ready')

    const advisoryQueries = prismaMock.$queryRaw.mock.calls
      .map(([query]) => (query as { strings?: readonly string[] })?.strings?.join('?') ?? '')
      .filter((sql) => sql.includes('pg_advisory_xact_lock'))
    expect(advisoryQueries).toHaveLength(2)
    expect(advisoryQueries.every((sql) => sql.includes('::text AS lock_token'))).toBe(true)
  })

  it('turns a potential YouTube mutation missed by strict routing into a status-only lane', async () => {
    const wording = 'Please try searching YouTube for Fix You'
    const lane = await resolveDirectYouTubeTurnRequest('conv-1', [wording], 'turn-1')
    expect(lane).toEqual({
      state: 'unavailable',
      ownerRequest: wording,
      token: null,
      blockerText: DIRECT_YOUTUBE_ROUTE_MISS_BLOCKER,
    })
    expect(hardGateUnavailableDirectYouTubeLane(lane)).toEqual({
      text: DIRECT_YOUTUBE_ROUTE_MISS_BLOCKER,
      replaced: true,
    })
    expect(store.row).toBeNull()
  })

  it('linearizes direct setup effects behind the current-owner lane fence', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const effect = vi.fn(async () => 'ticket-or-switch')

    await expect(runDirectYouTubeOwnerFencedEffect({
      conversationId: 'conv-1', token: opened.token, effect,
    })).resolves.toEqual({ authorized: true, value: 'ticket-or-switch' })
    expect(effect).toHaveBeenCalledOnce()

    ownerFence.executionCurrent.mockResolvedValue(false)
    effect.mockClear()
    await expect(runDirectYouTubeOwnerFencedEffect({
      conversationId: 'conv-1', token: opened.token, effect,
    })).resolves.toEqual({ authorized: false })
    expect(effect).not.toHaveBeenCalled()
  })

  it('rejects a pre-Stop setup effect even after the global switch is resumed', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    store.dispatchBoundary = new Date(
      (defaultTurn('turn-1').startedAt as Date).getTime() + 1,
    ).toISOString()
    const effect = vi.fn(async () => 'pairing-ticket')

    await expect(runDirectYouTubeOwnerFencedEffect({
      conversationId: 'conv-1', token: opened.token, effect,
    })).resolves.toEqual({ authorized: false })
    expect(effect).not.toHaveBeenCalled()
  })

  it('creates no late pre-Stop lane when STOP wins the global dispatch lock', async () => {
    const turn = defaultTurn('turn-1')
    store.turns.set('turn-1', turn)
    prismaMock.$queryRaw.mockImplementation(async (query?: unknown) => {
      const sql = (query as { strings?: readonly string[] } | undefined)?.strings?.join('?') ?? ''
      if (sql.includes('live_browser_dispatch_global')) {
        store.dispatchBoundary = new Date(
          (turn.startedAt as Date).getTime() + 1,
        ).toISOString()
      }
      return [{ locked: true }]
    })

    await expect(resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1'))
      .resolves.toEqual({ state: 'unavailable', ownerRequest: REQUEST, token: null })
    expect(store.row).toBeNull()
  })

  it('does not resume a pre-Stop lane from a post-Stop continuation turn', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const turn1StartedAt = defaultTurn('turn-1').startedAt as Date
    const turn2StartedAt = defaultTurn('turn-2').startedAt as Date
    store.dispatchBoundary = new Date(
      turn1StartedAt.getTime() + Math.floor(
        (turn2StartedAt.getTime() - turn1StartedAt.getTime()) / 2,
      ),
    ).toISOString()

    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-2'))
      .resolves.toEqual({ state: 'unavailable', ownerRequest: 'continue', token: null })
    expect(store.row).toMatchObject({
      currentStep: 'open',
      artifacts: { laneToken: 'turn-1' },
    })
    await expect(isDirectYouTubeTurnLaneCurrent('conv-1', opened)).resolves.toBe(false)

    const freshRequest = 'Play Yellow by Coldplay on YouTube'
    await expect(resolveDirectYouTubeTurnRequest('conv-1', [freshRequest], 'turn-2'))
      .resolves.toEqual({ state: 'ready', ownerRequest: freshRequest, token: 'turn-2' })
  })

  it('rejects late reserve, bind, and awaiting settlement from a pre-Stop turn', async () => {
    store.turns.set('turn-1', {
      ...defaultTurn('turn-1'),
      userMessageId: 'owner-message-1',
    })
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    store.dispatchBoundary = new Date(
      (defaultTurn('turn-1').startedAt as Date).getTime() + 1,
    ).toISOString()

    await expect(reserveDirectYouTubeAskCard({
      conversationId: 'conv-1', token: opened.token,
    })).resolves.toBeNull()

    store.cards.set('late-bound-card', {
      id: 'late-bound-card', conversationId: 'conv-1', status: 'pending', selectedOption: null,
    })
    await expect(bindDirectYouTubeAskCard({
      conversationId: 'conv-1',
      token: opened.token,
      askCardId: 'late-bound-card',
      options: ['Continue', 'Cancel'],
    })).resolves.toBe(false)
    expect(store.cards.get('late-bound-card')).toMatchObject({ status: 'superseded' })

    store.cards.set('late-settlement-card', {
      id: 'late-settlement-card', conversationId: 'conv-1', status: 'pending', selectedOption: null,
    })
    await expect(settleDirectYouTubeTurnLane({
      conversationId: 'conv-1',
      token: opened.token,
      outcome: 'awaiting_owner',
      expectedOwnerReplies: ['Continue', 'Cancel'],
      expectedAskCardId: 'late-settlement-card',
    })).resolves.toBe(false)
    expect(store.cards.get('late-settlement-card')).toMatchObject({ status: 'superseded' })
    expect(store.row).toMatchObject({ status: 'active', currentStep: 'open' })
  })

  afterEach(() => vi.useRealTimers())

  it.each(['done', 'continue', 'এই ম্যাক', 'My Mac Chrome', 'লগইন করেছি', 'দ্বিতীয়টা'])(
    'recognizes an owner-gate continuation: %s',
    (text) => expect(isDirectBrowserContinuationText(text)).toBe(true),
  )

  it('persists the initial request before returning and round-trips a continuation', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    expect(opened).toEqual({ state: 'ready', ownerRequest: REQUEST, token: 'turn-1' })
    expect(prismaMock.agentConversationFocus.create).toHaveBeenCalledTimes(1)
    expect(store.row).toMatchObject({
      conversationId: 'conv-1',
      kind: 'direct_youtube_browser',
      status: 'active',
      currentStep: 'open',
      artifacts: { laneToken: 'turn-1' },
    })

    const resumed = await resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-2')
    expect(resumed).toEqual({ state: 'ready', ownerRequest: REQUEST, token: 'turn-2' })
    expect(store.row).toMatchObject({ currentStep: 'continuing', artifacts: { laneToken: 'turn-2' } })
  })

  it('keeps an explicit pair/login handoff open for at most ten minutes', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await expect(settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
    })).resolves.toBe(true)
    expect(store.row).toMatchObject({ status: 'awaiting_owner', currentStep: 'awaiting_owner' })
    expect((store.row!.leaseUntil as Date).getTime() - NOW.getTime()).toBeLessThanOrEqual(
      DIRECT_YOUTUBE_LANE_MAX_LEASE_MS,
    )

    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['লগইন করেছি'], 'turn-2'))
      .resolves.toEqual({ state: 'ready', ownerRequest: REQUEST, token: 'turn-2' })
  })

  it('resumes from the exact persisted arbitrary device/card option', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1',
      token: opened.token,
      outcome: 'awaiting_owner',
      expectedOwnerReplies: ['Office Mac Chrome', 'পেয়ার করা শেষ'],
      expectedAskCardId: 'device-card-1',
    })
    expect(store.row).toMatchObject({
      artifacts: {
        laneToken: 'turn-1',
        expectedOwnerReplies: ['Office Mac Chrome', 'পেয়ার করা শেষ'],
        expectedAskCardId: 'device-card-1',
      },
    })
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1',
      ['Office Mac Chrome'],
      'turn-2',
      { askCardId: 'device-card-1', selectedOption: 'Office Mac Chrome' },
    )).resolves.toEqual({
      state: 'ready',
      ownerRequest: REQUEST,
      token: 'turn-2',
      selectedOwnerReply: 'Office Mac Chrome',
    })
  })

  it('binds duplicate display-name options to immutable device ids and carries the selection', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const staged = await stageDirectYouTubeDeviceOptions({
      conversationId: 'conv-1',
      token: opened.token,
      devices: [
        { deviceId: 'dev-z', deviceName: 'Office Mac Chrome' },
        { deviceId: 'dev-a', deviceName: 'Office Mac Chrome' },
      ],
    })
    expect(staged).toEqual({
      state: 'required',
      options: [
        { option: 'Office Mac Chrome · dev-a', deviceId: 'dev-a', deviceName: 'Office Mac Chrome' },
        { option: 'Office Mac Chrome · dev-z', deviceId: 'dev-z', deviceName: 'Office Mac Chrome' },
      ],
    })
    await expect(settleDirectYouTubeTurnLane({
      conversationId: 'conv-1',
      token: opened.token,
      outcome: 'awaiting_owner',
      expectedOwnerReplies: (staged.state === 'required' ? staged.options : []).map(({ option }) => option),
      expectedAskCardId: 'device-card-duplicate',
    })).resolves.toBe(true)

    const resumed = await resolveDirectYouTubeTurnRequest(
      'conv-1',
      ['Office Mac Chrome · dev-z'],
      'turn-2',
      { askCardId: 'device-card-duplicate', selectedOption: 'Office Mac Chrome · dev-z' },
    )
    expect(resumed).toEqual({
      state: 'ready',
      ownerRequest: REQUEST,
      token: 'turn-2',
      selectedOwnerReply: 'Office Mac Chrome · dev-z',
      selectedDeviceId: 'dev-z',
      selectedDeviceName: 'Office Mac Chrome',
    })
    await expect(getDirectYouTubeDeviceSelection('conv-1', 'turn-2')).resolves.toEqual({
      state: 'selected',
      selectedOption: 'Office Mac Chrome · dev-z',
      deviceId: 'dev-z',
      deviceName: 'Office Mac Chrome',
    })

    await expect(settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: 'turn-2', outcome: 'continuing',
    })).resolves.toBe(true)
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-3')).resolves.toMatchObject({
      state: 'ready',
      selectedDeviceId: 'dev-z',
      selectedDeviceName: 'Office Mac Chrome',
    })
  })

  it('durably binds the first sole online device across continuation turns', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await expect(bindDirectYouTubeSoleDevice({
      conversationId: 'conv-1',
      token: opened.token,
      device: { deviceId: 'dev-home', deviceName: 'Home Mac Chrome' },
    })).resolves.toEqual({
      state: 'selected',
      selectedOption: 'Home Mac Chrome',
      deviceId: 'dev-home',
      deviceName: 'Home Mac Chrome',
    })
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'continuing',
    })
    const resumed = await resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-2')
    expect(resumed).toMatchObject({
      state: 'ready', selectedDeviceId: 'dev-home', selectedDeviceName: 'Home Mac Chrome',
    })
    await expect(getDirectYouTubeDeviceSelection('conv-1', 'turn-2')).resolves.toMatchObject({
      state: 'selected', deviceId: 'dev-home', deviceName: 'Home Mac Chrome',
    })
  })

  it('immutably binds the exact clicked media identity and preserves it across continuation', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const media = {
      conversationId: 'conv-1',
      token: opened.token,
      videoId: 'selected001',
      title: 'Coldplay - Fix You (Official Video)',
      fingerprint: '["a","","link","","","Coldplay - Fix You (Official Video)","/watch?v=selected001"]',
    }
    await expect(bindDirectYouTubeSelectedMedia(media)).resolves.toBe(true)
    await expect(bindDirectYouTubeSelectedMedia(media)).resolves.toBe(true)
    await expect(bindDirectYouTubeSelectedMedia({
      ...media,
      videoId: 'another0001',
      title: 'Fix You piano tutorial',
    })).resolves.toBe(false)
    await expect(getDirectYouTubeSelectedMedia('conv-1', opened.token)).resolves.toEqual({
      state: 'selected',
      videoId: media.videoId,
      title: media.title,
      fingerprint: media.fingerprint,
    })

    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'continuing',
    })
    const resumed = await resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-2')
    expect(resumed).toMatchObject({ state: 'ready', token: 'turn-2' })
    await expect(getDirectYouTubeSelectedMedia('conv-1', 'turn-2')).resolves.toMatchObject({
      state: 'selected', videoId: media.videoId, title: media.title,
    })

    const artifacts = { ...(store.row?.artifacts as Record<string, unknown>) }
    delete artifacts.selectedMediaTitle
    store.row = { ...store.row!, artifacts }
    await expect(getDirectYouTubeSelectedMedia('conv-1', 'turn-2'))
      .resolves.toEqual({ state: 'unavailable' })
  })

  it('does not let a model device substring or generic ordinal skip a required device card', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const staged = await stageDirectYouTubeDeviceOptions({
      conversationId: 'conv-1',
      token: opened.token,
      devices: [
        { deviceId: 'dev-home', deviceName: 'Home Mac Chrome' },
        { deviceId: 'dev-office', deviceName: 'Office Mac Chrome' },
      ],
    })
    if (staged.state !== 'required') throw new Error('expected device choice')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: staged.options.map(({ option }) => option),
      expectedAskCardId: 'device-card-1',
    })

    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['Office'], 'turn-2'))
      .resolves.toEqual({ state: 'unavailable', ownerRequest: 'Office', token: null })
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['second'], 'turn-3'))
      .resolves.toEqual({ state: 'unavailable', ownerRequest: 'second', token: null })
  })

  it('refuses an awaiting-owner card that is not exactly the complete staged device snapshot', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const staged = await stageDirectYouTubeDeviceOptions({
      conversationId: 'conv-1', token: opened.token,
      devices: [
        { deviceId: 'dev-home', deviceName: 'Home Mac Chrome' },
        { deviceId: 'dev-office', deviceName: 'Office Mac Chrome' },
      ],
    })
    if (staged.state !== 'required') throw new Error('expected device choice')
    store.cards.set('mixed-device-card', {
      id: 'mixed-device-card', conversationId: 'conv-1', status: 'pending', selectedOption: null,
    })
    await expect(settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: [...staged.options.map(({ option }) => option), 'Yes, continue'],
      expectedAskCardId: 'mixed-device-card',
    })).resolves.toBe(false)
    expect(store.row).toMatchObject({ status: 'active', currentStep: 'open' })
    expect(store.cards.get('mixed-device-card')).toMatchObject({ status: 'superseded' })
  })

  it('atomically makes a just-created exact device card resumable before turn-end settlement', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const staged = await stageDirectYouTubeDeviceOptions({
      conversationId: 'conv-1', token: opened.token,
      devices: [
        { deviceId: 'dev-home', deviceName: 'Home Mac Chrome' },
        { deviceId: 'dev-office', deviceName: 'Office Mac Chrome' },
      ],
    })
    if (staged.state !== 'required') throw new Error('expected device choice')
    const options = staged.options.map(({ option }) => option)
    store.cards.set('immediate-device-card', {
      id: 'immediate-device-card', conversationId: 'conv-1', status: 'pending', selectedOption: null,
    })

    await expect(bindDirectYouTubeAskCard({
      conversationId: 'conv-1', token: opened.token,
      askCardId: 'immediate-device-card', options,
    })).resolves.toBe(true)
    expect(store.row).toMatchObject({
      status: 'awaiting_owner',
      currentStep: 'awaiting_owner',
      artifacts: {
        laneToken: 'turn-1',
        expectedAskCardId: 'immediate-device-card',
        expectedOwnerReplies: options,
      },
    })
    expect(await isDirectYouTubeTurnLaneCurrent('conv-1', opened)).toBe(true)

    const selectedOption = options[0]
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1',
      [selectedOption],
      'turn-2',
      { askCardId: 'immediate-device-card', selectedOption },
    )).resolves.toMatchObject({
      state: 'ready',
      ownerRequest: REQUEST,
      token: 'turn-2',
      selectedDeviceId: 'dev-home',
      selectedDeviceName: 'Home Mac Chrome',
    })
    expect(store.row).toMatchObject({
      status: 'active',
      currentStep: 'continuing',
      artifacts: {
        laneToken: 'turn-2',
        selectedDeviceId: 'dev-home',
        selectedDeviceName: 'Home Mac Chrome',
      },
    })
  })

  it('rejects and supersedes a card when newer owner input commits before bind', async () => {
    store.turns.set('turn-1', {
      ...defaultTurn('turn-1'),
      userMessageId: 'owner-message-1',
    })
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const staged = await stageDirectYouTubeDeviceOptions({
      conversationId: 'conv-1', token: opened.token,
      devices: [
        { deviceId: 'dev-home', deviceName: 'Home Mac Chrome' },
        { deviceId: 'dev-office', deviceName: 'Office Mac Chrome' },
      ],
    })
    if (staged.state !== 'required') throw new Error('expected device choice')
    const reservation = await reserveDirectYouTubeAskCard({
      conversationId: 'conv-1', token: opened.token,
    })
    if (!reservation) throw new Error('expected reserved card')
    store.cards.set(reservation.askCardId, {
      id: reservation.askCardId,
      conversationId: 'conv-1',
      status: 'pending',
      selectedOption: null,
    })

    ownerFence.executionCurrent.mockResolvedValueOnce(false)
    await expect(bindDirectYouTubeAskCard({
      conversationId: 'conv-1',
      token: opened.token,
      askCardId: reservation.askCardId,
      options: staged.options.map(({ option }) => option),
    })).resolves.toBe(false)

    expect(store.cards.get(reservation.askCardId)).toMatchObject({ status: 'superseded' })
    expect(store.row).toMatchObject({
      status: 'active',
      currentStep: 'open',
      artifacts: { laneToken: 'turn-1', expectedAskCardId: reservation.askCardId },
    })
  })

  it('does not resume an exact old card across an intervening owner task', async () => {
    store.turns.set('turn-1', {
      ...defaultTurn('turn-1'),
      userMessageId: 'owner-message-1',
    })
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const staged = await stageDirectYouTubeDeviceOptions({
      conversationId: 'conv-1', token: opened.token,
      devices: [
        { deviceId: 'dev-home', deviceName: 'Home Mac Chrome' },
        { deviceId: 'dev-office', deviceName: 'Office Mac Chrome' },
      ],
    })
    if (staged.state !== 'required') throw new Error('expected device choice')
    const options = staged.options.map(({ option }) => option)
    const reservation = await reserveDirectYouTubeAskCard({
      conversationId: 'conv-1', token: opened.token,
    })
    if (!reservation) throw new Error('expected reserved card')
    store.cards.set(reservation.askCardId, {
      id: reservation.askCardId,
      conversationId: 'conv-1',
      status: 'pending',
      selectedOption: null,
    })
    await expect(bindDirectYouTubeAskCard({
      conversationId: 'conv-1', token: opened.token,
      askCardId: reservation.askCardId, options,
    })).resolves.toBe(true)

    ownerFence.continuationCurrent.mockResolvedValueOnce(false)
    const selectedOption = options[0]
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1',
      [selectedOption],
      'turn-3',
      { askCardId: reservation.askCardId, selectedOption },
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: selectedOption, token: null })
    expect(store.row).toMatchObject({
      status: 'awaiting_owner',
      currentStep: 'awaiting_owner',
      artifacts: { laneToken: 'turn-1', expectedAskCardId: reservation.askCardId },
    })
  })

  it('tombstones a reserved direct card after bind cleanup fails before terminal admission', async () => {
    store.turns.set('turn-1', {
      ...defaultTurn('turn-1'),
      userMessageId: 'owner-message-1',
    })
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const reservation = await reserveDirectYouTubeAskCard({
      conversationId: 'conv-1', token: opened.token,
    })
    if (!reservation) throw new Error('expected direct card reservation')
    store.cards.set(reservation.askCardId, {
      id: reservation.askCardId,
      conversationId: 'conv-1',
      status: 'pending',
      selectedOption: null,
    })

    // Model the exact orphan sequence: the card row exists, all bind CAS
    // attempts lose/fail, and the immediate supersede cleanup also fails.
    for (let attempt = 0; attempt < 4; attempt++) {
      prismaMock.agentConversationFocus.updateMany.mockResolvedValueOnce({ count: 0 })
    }
    prismaMock.agentAskCard.updateMany.mockRejectedValueOnce(new Error('cleanup unavailable'))
    await expect(bindDirectYouTubeAskCard({
      conversationId: 'conv-1', token: opened.token,
      askCardId: reservation.askCardId, options: ['Continue', 'Cancel'],
    })).resolves.toBe(false)
    expect(store.cards.get(reservation.askCardId)).toMatchObject({ status: 'pending' })
    expect(store.row).toMatchObject({
      status: 'active',
      currentStep: 'open',
      artifacts: { expectedAskCardId: reservation.askCardId },
    })

    // Once storage recovers, terminal settlement knows the pre-reserved origin,
    // closes the actual card row, and retains its durable invalidation identity.
    await expect(settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'completed',
    })).resolves.toBe(true)
    expect(store.cards.get(reservation.askCardId)).toMatchObject({ status: 'superseded' })
    expect(store.row).toMatchObject({
      status: 'done',
      currentStep: 'completed',
      artifacts: { invalidatedAskCardIds: [reservation.askCardId] },
    })
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', ['Continue'], 'turn-2',
      { askCardId: reservation.askCardId, selectedOption: 'Continue' },
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: 'Continue', token: null })
  })

  it('supersedes a just-created card when its options do not equal the device snapshot', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await stageDirectYouTubeDeviceOptions({
      conversationId: 'conv-1', token: opened.token,
      devices: [
        { deviceId: 'dev-home', deviceName: 'Home Mac Chrome' },
        { deviceId: 'dev-office', deviceName: 'Office Mac Chrome' },
      ],
    })
    store.cards.set('unsafe-immediate-card', {
      id: 'unsafe-immediate-card', conversationId: 'conv-1', status: 'pending', selectedOption: null,
    })

    await expect(bindDirectYouTubeAskCard({
      conversationId: 'conv-1', token: opened.token,
      askCardId: 'unsafe-immediate-card', options: ['Home Mac Chrome', 'Yes'],
    })).resolves.toBe(false)
    expect(store.cards.get('unsafe-immediate-card')).toMatchObject({ status: 'superseded' })
    expect(store.row).toMatchObject({ status: 'active', currentStep: 'open' })
    expect((store.row?.artifacts as Record<string, unknown>).expectedAskCardId).toBeUndefined()
  })

  it('freezes an emitted card snapshot against rename, repair, and reorder races', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    const devices = [
      { deviceId: 'dev-a', deviceName: 'Home Mac Chrome' },
      { deviceId: 'dev-z', deviceName: 'Office Mac Chrome' },
    ]
    const staged = await stageDirectYouTubeDeviceOptions({
      conversationId: 'conv-1', token: opened.token, devices,
    })
    if (staged.state !== 'required') throw new Error('expected device choice')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: staged.options.map(({ option }) => option),
      expectedAskCardId: 'device-card-1',
    })
    await expect(stageDirectYouTubeDeviceOptions({
      conversationId: 'conv-1', token: opened.token, devices: [...devices].reverse(),
    })).resolves.toEqual(staged)
    await expect(stageDirectYouTubeDeviceOptions({
      conversationId: 'conv-1',
      token: opened.token,
      devices: [
        { deviceId: 'dev-a', deviceName: 'Renamed Chrome' },
        { deviceId: 'dev-new', deviceName: 'Office Mac Chrome' },
      ],
    })).resolves.toEqual({ state: 'unavailable' })
  })

  it('fails closed on an unmatched awaiting-owner reply instead of exposing broad tools', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: ['Home Mac Chrome', 'Office Mac Chrome'],
      expectedAskCardId: 'device-card-1',
    })
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['Different Mac'], 'turn-2'))
      .resolves.toEqual({ state: 'unavailable', ownerRequest: 'Different Mac', token: null })
    expect(store.row).toMatchObject({ status: 'awaiting_owner', currentStep: 'awaiting_owner' })
  })

  it('does not let a generic answer from an unrelated card resume the lane', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: ['Yes', 'No'],
      expectedAskCardId: 'youtube-card',
    })
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1',
      ['Yes'],
      'turn-2',
      { askCardId: 'unrelated-card', selectedOption: 'Yes' },
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: 'Yes', token: null })
    expect(store.row).toMatchObject({ status: 'awaiting_owner', currentStep: 'awaiting_owner' })
  })

  it('rejects an unrelated card id while the direct lane is open or continuing', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', ['continue'], 'turn-2',
      { askCardId: 'unrelated-open-card', selectedOption: 'continue' },
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: 'continue', token: null })
    expect(store.row).toMatchObject({ currentStep: 'open', artifacts: { laneToken: 'turn-1' } })

    await expect(settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'continuing',
    })).resolves.toBe(true)
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', ['continue'], 'turn-3',
      { askCardId: 'unrelated-continuing-card', selectedOption: 'continue' },
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: 'continue', token: null })
    expect(store.row).toMatchObject({ currentStep: 'continuing', artifacts: { laneToken: 'turn-1' } })
  })

  it('does not let a delayed exact-card answer overwrite a newer direct goal', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: ['Office Mac Chrome'], expectedAskCardId: 'stale-card',
    })
    const staleRow = { ...store.row!, artifacts: { ...(store.row?.artifacts as object) } }
    let reads = 0
    prismaMock.agentConversationFocus.findUnique.mockImplementation(async () => {
      reads++
      if (reads === 1) return { ...staleRow }
      store.row = {
        ...store.row!,
        goal: 'Play Interstellar soundtrack on YouTube',
        status: 'active',
        currentStep: 'open',
        version: Number(store.row?.version) + 1,
        artifacts: { laneToken: 'turn-3' },
      }
      return { ...store.row }
    })

    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', ['Office Mac Chrome'], 'turn-2',
      { askCardId: 'stale-card', selectedOption: 'Office Mac Chrome' },
    )).resolves.toEqual({
      state: 'unavailable', ownerRequest: 'Office Mac Chrome', token: null,
    })
    expect(store.row).toMatchObject({
      goal: 'Play Interstellar soundtrack on YouTube',
      currentStep: 'open',
      artifacts: { laneToken: 'turn-3' },
    })
  })

  it('rejects and closes an expired lane', async () => {
    await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    store.row = { ...store.row!, leaseUntil: new Date(NOW.getTime() - 1) }
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-2')).resolves.toBeNull()
    expect(store.row).toMatchObject({ status: 'abandoned', currentStep: 'expired' })
  })

  it('fails closed on an expired device-card tap instead of widening to broad routing', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: ['Office Mac Chrome'], expectedAskCardId: 'late-device-card',
    })
    store.row = { ...store.row!, leaseUntil: new Date(NOW.getTime() - 1) }
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', ['Office Mac Chrome'], 'turn-2',
      { askCardId: 'late-device-card', selectedOption: 'Office Mac Chrome' },
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: 'Office Mac Chrome', token: null })
    expect(store.row).toMatchObject({
      status: 'abandoned',
      currentStep: 'expired',
      artifacts: { invalidatedAskCardIds: ['late-device-card'] },
    })
  })

  it('fails closed on a device-card tap after steering revoked the lane', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: ['Office Mac Chrome'], expectedAskCardId: 'steered-card',
    })
    await revokeDirectYouTubeTurnLaneForSteering('conv-1', opened.token)
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', ['Office Mac Chrome'], 'turn-2',
      { askCardId: 'steered-card', selectedOption: 'Office Mac Chrome' },
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: 'Office Mac Chrome', token: null })
  })

  it('fails closed on a device-card tap after terminal settlement', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: ['Office Mac Chrome'], expectedAskCardId: 'terminal-card',
    })
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'terminal_blocker',
    })
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', ['Office Mac Chrome'], 'turn-2',
      { askCardId: 'terminal-card', selectedOption: 'Office Mac Chrome' },
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: 'Office Mac Chrome', token: null })
  })

  it('fails closed on a device-card tap after a new owner task superseded the lane', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: ['Office Mac Chrome'], expectedAskCardId: 'superseded-card',
    })
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['cancel'], 'turn-2')).resolves.toBeNull()
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', ['Office Mac Chrome'], 'turn-3',
      { askCardId: 'superseded-card', selectedOption: 'Office Mac Chrome' },
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: 'Office Mac Chrome', token: null })
  })

  it('keeps more than eight old direct cards non-actionable', async () => {
    let lane = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (lane?.state !== 'ready') throw new Error('expected ready lane')
    for (let index = 0; index < 10; index++) {
      const cardId = `historical-card-${index}`
      const option = `Device option ${index}`
      store.cards.set(cardId, {
        id: cardId,
        conversationId: 'conv-1',
        question: 'Which device?',
        options: JSON.stringify([option]),
        questions: null,
        workflowRunId: null,
        status: 'pending',
        selectedOption: null,
      })
      await expect(settleDirectYouTubeTurnLane({
        conversationId: 'conv-1', token: lane.token, outcome: 'awaiting_owner',
        expectedOwnerReplies: [option], expectedAskCardId: cardId,
      })).resolves.toBe(true)
      lane = await resolveDirectYouTubeTurnRequest(
        'conv-1', [option], `turn-${index + 2}`,
        { askCardId: cardId, selectedOption: option },
      )
      if (lane?.state !== 'ready') throw new Error('expected resumed lane')
    }

    expect((store.row?.artifacts as { invalidatedAskCardIds?: string[] }).invalidatedAskCardIds)
      .toEqual(expect.arrayContaining(['historical-card-0', 'historical-card-9']))
    expect(store.cards.get('historical-card-0')).toMatchObject({ status: 'superseded' })
    const { answerAskCard } = await import('../../ask-cards')
    await expect(answerAskCard('historical-card-0', 'Device option 0')).resolves.toMatchObject({
      ok: false,
      alreadyAnswered: true,
    })
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', ['Device option 0'], 'late-turn',
      { askCardId: 'historical-card-0', selectedOption: 'Device option 0' },
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: 'Device option 0', token: null })
  })

  it('exports a fail-closed bulk card superseder for settlement callers', async () => {
    store.cards.set('card-a', { id: 'card-a', conversationId: 'conv-1', status: 'pending' })
    store.cards.set('card-b', { id: 'card-b', conversationId: 'conv-1', status: 'answered' })
    await expect(supersedeDirectYouTubeAskCards('conv-1', ['card-a', 'card-b']))
      .resolves.toBe(true)
    expect(store.cards.get('card-a')).toMatchObject({ status: 'superseded' })
    expect(store.cards.get('card-b')).toMatchObject({ status: 'superseded' })

    prismaMock.agentAskCard.updateMany.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(supersedeDirectYouTubeAskCards('conv-1', ['card-c'])).resolves.toBe(false)
  })

  it('does not resume after verified completion', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({ conversationId: 'conv-1', token: opened.token, outcome: 'completed' })
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-2')).resolves.toBeNull()
    expect(store.row).toMatchObject({ status: 'done', currentStep: 'completed' })
  })

  it('does not resume after a terminal hard blocker', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'terminal_blocker',
    })
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['done'], 'turn-2')).resolves.toBeNull()
    expect(store.row).toMatchObject({ status: 'abandoned', currentStep: 'terminal_blocker' })
  })

  it('closes a stored open lane when the owner gives a substantive new request', async () => {
    await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['send an email'], 'turn-2')).resolves.toBeNull()
    expect(store.row).toMatchObject({ status: 'abandoned', currentStep: 'superseded_by_owner' })
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-3')).resolves.toBeNull()
  })

  it('fails closed when a substantive close cannot be durably written', async () => {
    await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    prismaMock.agentConversationFocus.updateMany.mockResolvedValue({ count: 0 })
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['send an email'], 'turn-2'))
      .resolves.toEqual({ state: 'unavailable', ownerRequest: 'send an email', token: null })
    expect(store.row).toMatchObject({ status: 'active', currentStep: 'open' })
  })

  it('fails closed when an awaiting-owner cancel cannot supersede its card', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    store.cards.set('cancel-card', {
      id: 'cancel-card', conversationId: 'conv-1', status: 'pending', selectedOption: null,
    })
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'awaiting_owner',
      expectedOwnerReplies: ['Continue', 'Cancel'], expectedAskCardId: 'cancel-card',
    })
    prismaMock.agentAskCard.updateMany.mockRejectedValueOnce(new Error('card store unavailable'))
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['cancel'], 'turn-2'))
      .resolves.toEqual({ state: 'unavailable', ownerRequest: 'cancel', token: null })
    expect(store.row).toMatchObject({ status: 'awaiting_owner', currentStep: 'awaiting_owner' })
  })

  it('creates no lane authority when Stop wins the shared admission lock', async () => {
    const stopped = {
      ...defaultTurn('turn-stopped'),
      status: 'canceled',
      cancelRequested: true,
    }
    prismaMock.$queryRaw.mockImplementationOnce(async () => {
      store.turns.set('turn-stopped', stopped)
      return [{ locked: true }]
    })

    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', [REQUEST], 'turn-stopped',
    )).resolves.toEqual({ state: 'unavailable', ownerRequest: REQUEST, token: null })
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2)
    expect(prismaMock.agentConversationFocus.create).not.toHaveBeenCalled()
    expect(store.row).toBeNull()
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-2'))
      .resolves.toBeNull()
  })

  it('does not reactivate an open lane into a canceled continuation turn', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    store.turns.set('turn-2', {
      ...defaultTurn('turn-2'), status: 'canceled', cancelRequested: true,
    })
    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-2'))
      .resolves.toEqual({ state: 'unavailable', ownerRequest: 'continue', token: null })
    expect(store.row).toMatchObject({ currentStep: 'open', artifacts: { laneToken: 'turn-1' } })
  })

  it('does not let an older delayed running turn replace a newer direct goal', async () => {
    store.turns.set('turn-a', {
      ...defaultTurn('turn-a'), startedAt: new Date('2026-08-21T09:00:00.000Z'),
    })
    store.turns.set('turn-b', {
      ...defaultTurn('turn-b'), startedAt: new Date('2026-08-21T09:01:00.000Z'),
    })
    const newerRequest = 'Play Interstellar soundtrack on YouTube'
    await expect(resolveDirectYouTubeTurnRequest('conv-1', [newerRequest], 'turn-b'))
      .resolves.toMatchObject({ state: 'ready', ownerRequest: newerRequest, token: 'turn-b' })
    await expect(resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-a'))
      .resolves.toEqual({ state: 'unavailable', ownerRequest: REQUEST, token: null })
    expect(store.row).toMatchObject({ goal: newerRequest, artifacts: { laneToken: 'turn-b' } })
  })

  it('does not let an older delayed broad turn close a newer direct goal', async () => {
    store.turns.set('turn-old', {
      ...defaultTurn('turn-old'), startedAt: new Date('2026-08-21T09:00:00.000Z'),
    })
    store.turns.set('turn-new', {
      ...defaultTurn('turn-new'), startedAt: new Date('2026-08-21T09:01:00.000Z'),
    })
    const newerRequest = 'Play Interstellar soundtrack on YouTube'
    await resolveDirectYouTubeTurnRequest('conv-1', [newerRequest], 'turn-new')

    await expect(resolveDirectYouTubeTurnRequest('conv-1', ['send an email'], 'turn-old'))
      .resolves.toEqual({ state: 'unavailable', ownerRequest: 'send an email', token: null })
    expect(store.row).toMatchObject({
      status: 'active', goal: newerRequest, artifacts: { laneToken: 'turn-new' },
    })
  })

  it('allows a later unrelated card after the direct lane is terminal', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    await settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'completed',
    })
    await expect(resolveDirectYouTubeTurnRequest(
      'conv-1', ['Yes'], 'turn-2',
      { askCardId: 'later-unrelated-card', selectedOption: 'Yes' },
    )).resolves.toBeNull()
    expect(store.row).toMatchObject({ status: 'done', currentStep: 'completed' })
  })

  it('never authorizes continuation from transcript proximity alone', async () => {
    await expect(resolveDirectYouTubeTurnRequest('conv-1', [REQUEST, 'continue'], 'turn-2')).resolves.toBeNull()
  })

  it('returns a fail-closed status-only state when the durable read rejects', async () => {
    prismaMock.agentConversationFocus.findUnique.mockRejectedValueOnce(new Error('database unavailable'))
    const unavailable = await resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-2')
    expect(unavailable).toEqual({
      state: 'unavailable', ownerRequest: 'continue', token: null,
    })
    expect([...DIRECT_YOUTUBE_LANE_UNAVAILABLE_TOOL_NAMES]).toEqual(['live_browser_status'])
    expect(hardGateUnavailableDirectYouTubeLane(unavailable)).toMatchObject({
      replaced: true,
      text: expect.stringContaining('playback চলছে বলে দাবি করছি না'),
    })
  })

  it('uses the token as a fence against an old turn settling a newer one', async () => {
    await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    await resolveDirectYouTubeTurnRequest('conv-1', ['continue'], 'turn-2')
    await expect(settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: 'turn-1', outcome: 'terminal_blocker',
    })).resolves.toBe(false)
    expect(store.row).toMatchObject({ status: 'active', artifacts: { laneToken: 'turn-2' } })
  })

  it('reports a failed terminal settlement so callers can replace success before final delivery', async () => {
    const opened = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (opened?.state !== 'ready') throw new Error('expected ready lane')
    prismaMock.agentConversationFocus.updateMany.mockRejectedValue(new Error('write unavailable'))
    await expect(settleDirectYouTubeTurnLane({
      conversationId: 'conv-1', token: opened.token, outcome: 'completed',
    })).resolves.toBe(false)
    expect(DIRECT_YOUTUBE_LANE_SETTLEMENT_BLOCKER).toContain('completion final করছি না')
    expect(store.row).toMatchObject({ status: 'active', currentStep: 'open' })
  })

  it('rejects stale, expired, and unreadable lanes at immediate tool execution', async () => {
    const oldLane = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    expect(await isDirectYouTubeTurnLaneCurrent('conv-1', oldLane)).toBe(true)

    const currentLane = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-2')
    expect(await isDirectYouTubeTurnLaneCurrent('conv-1', oldLane)).toBe(false)
    expect(await isDirectYouTubeTurnLaneCurrent('conv-1', currentLane)).toBe(true)

    ownerFence.executionCurrent.mockResolvedValueOnce(false)
    expect(await isDirectYouTubeTurnLaneCurrent('conv-1', currentLane)).toBe(false)

    store.row = { ...store.row!, leaseUntil: new Date(NOW.getTime() - 1) }
    expect(await isDirectYouTubeTurnLaneCurrent('conv-1', currentLane)).toBe(false)

    prismaMock.agentConversationFocus.findUnique.mockRejectedValueOnce(new Error('database unavailable'))
    expect(await isDirectYouTubeTurnLaneCurrent('conv-1', currentLane)).toBe(false)
  })

  it('revokes browser authority when steering arrives between LOOK and ACT', async () => {
    const lane = await resolveDirectYouTubeTurnRequest('conv-1', [REQUEST], 'turn-1')
    if (lane?.state !== 'ready') throw new Error('expected ready lane')
    expect(await isDirectYouTubeTurnLaneCurrent('conv-1', lane)).toBe(true)
    await expect(revokeDirectYouTubeTurnLaneForSteering('conv-1', lane.token)).resolves.toBe(true)
    expect(store.row).toMatchObject({ status: 'abandoned', currentStep: 'steered_by_owner' })
    expect(await isDirectYouTubeTurnLaneCurrent('conv-1', lane)).toBe(false)
  })
})
