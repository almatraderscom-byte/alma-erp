import { describe, expect, it, vi } from 'vitest'
import {
  consumeJsonSseResponse,
  createDurableReplayResetGate,
  createExactTurnConversationBinding,
  clearPersistedDurableTurn,
  loadPersistedDurableTurn,
  reconcilePersistedDurableTurn,
  releaseExactTurnObserver,
  savePersistedDurableTurn,
  SseEventConsumerError,
  suspendExactTurnObserverForNavigation,
  tailExactTurnStream,
} from '@/agent/lib/durable-turn-stream-client'

const encoder = new TextEncoder()

function responseFromChunks(chunks: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }))
}

describe('tailExactTurnStream', () => {
  it('round-trips one exact cold-recovery turn and cursor, rejecting corrupt/latest-only state', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const descriptor = { turnId: 'turn-a', conversationId: 'conv-a', lastSeq: 9 }
    savePersistedDurableTurn(storage, descriptor)
    expect(loadPersistedDurableTurn(storage)).toEqual(descriptor)

    clearPersistedDurableTurn(storage, 'turn-newer')
    expect(loadPersistedDurableTurn(storage)).toEqual(descriptor)
    clearPersistedDurableTurn(storage, 'turn-a')
    expect(loadPersistedDurableTurn(storage)).toBeNull()

    values.set('alma:durable-turn:v1', '{"conversationId":"conv-a","lastSeq":9}')
    expect(loadPersistedDurableTurn(storage)).toBeNull()
  })

  it('retains the descriptor until the exact assistant row is observed; a newer row cannot satisfy it', async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const descriptor = { turnId: 'turn-a', conversationId: 'conv-a', lastSeq: 4 }
    savePersistedDurableTurn(storage, descriptor)
    const reads = [
      [{ id: 'assistant-newer' }],
      [{ id: 'assistant-newer' }, { id: 'assistant-exact' }],
    ]

    const reconciled = await reconcilePersistedDurableTurn({
      storage,
      turnId: 'turn-a',
      assistantMessageId: 'assistant-exact',
      allowNoAssistantRow: false,
      readRows: async () => reads.shift()!,
      attempts: 2,
      sleep: async () => {
        expect(loadPersistedDurableTurn(storage)).toEqual(descriptor)
      },
    })

    expect(reconciled).toBe(true)
    expect(loadPersistedDurableTurn(storage)).toBeNull()

    savePersistedDurableTurn(storage, descriptor)
    await expect(reconcilePersistedDurableTurn({
      storage,
      turnId: 'turn-a',
      assistantMessageId: 'assistant-exact',
      allowNoAssistantRow: false,
      readRows: async () => [{ id: 'assistant-newer' }],
      attempts: 1,
    })).resolves.toBe(false)
    expect(loadPersistedDurableTurn(storage)).toEqual(descriptor)
  })

  it('allows a confirmed error/canceled terminal to reconcile without an assistant row', async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    savePersistedDurableTurn(storage, { turnId: 'turn-error', conversationId: 'conv-a', lastSeq: -1 })
    await expect(reconcilePersistedDurableTurn({
      storage,
      turnId: 'turn-error',
      assistantMessageId: null,
      allowNoAssistantRow: true,
      readRows: async () => [],
      attempts: 1,
    })).resolves.toBe(true)
    expect(loadPersistedDurableTurn(storage)).toBeNull()
  })

  it('never clears a successful done descriptor without its exact assistant row', async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const descriptor = { turnId: 'turn-zero', conversationId: 'conv-a', lastSeq: -1 }
    savePersistedDurableTurn(storage, descriptor)
    let reads = 0
    const reconciled = await reconcilePersistedDurableTurn({
      storage,
      turnId: descriptor.turnId,
      assistantMessageId: null,
      allowNoAssistantRow: false,
      allowNoAssistantRowAfterAttempts: true,
      readRows: async () => { reads += 1; return [] },
      attempts: 3,
      sleep: async () => {
        expect(loadPersistedDurableTurn(storage)).toEqual(descriptor)
      },
    })

    expect(reads).toBe(3)
    expect(reconciled).toBe(false)
    expect(loadPersistedDurableTurn(storage)).toEqual(descriptor)
  })

  it('clears on a later background reconciliation only after the exact row appears', async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const descriptor = { turnId: 'turn-delayed', conversationId: 'conv-a', lastSeq: 8 }
    savePersistedDurableTurn(storage, descriptor)
    const base = {
      storage,
      turnId: descriptor.turnId,
      assistantMessageId: 'assistant-delayed',
      allowNoAssistantRow: false,
      attempts: 1,
    }

    await expect(reconcilePersistedDurableTurn({
      ...base,
      readRows: async () => [],
    })).resolves.toBe(false)
    expect(loadPersistedDurableTurn(storage)).toEqual(descriptor)

    await expect(reconcilePersistedDurableTurn({
      ...base,
      readRows: async () => [{ id: 'assistant-delayed' }],
    })).resolves.toBe(true)
    expect(loadPersistedDurableTurn(storage)).toBeNull()
  })

  it('navigation abort retains observer ownership until finally releases global streaming state', () => {
    const controller = new AbortController()
    const slot = { current: { turnId: 'turn-a', controller } }

    suspendExactTurnObserverForNavigation(slot, controller)
    expect(controller.signal.aborted).toBe(true)
    expect(slot.current?.turnId).toBe('turn-a')

    expect(releaseExactTurnObserver(slot, controller)).toBe(true)
    expect(slot.current).toBeNull()
  })

  it('keeps terminal reconciliation bound to the source conversation across post-done compaction', async () => {
    const binding = createExactTurnConversationBinding(null)
    binding.observeSource('conv-old')
    const terminalConversationId = binding.sourceConversationId
    binding.compactTo('conv-new')

    expect(terminalConversationId).toBe('conv-old')
    expect(binding.activeConversationId).toBe('conv-new')

    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    savePersistedDurableTurn(storage, {
      turnId: 'turn-a',
      conversationId: 'conv-old',
      activeConversationId: binding.activeConversationId!,
      lastSeq: 2,
    })
    expect(loadPersistedDurableTurn(storage)?.activeConversationId).toBe('conv-new')
    const fetchedConversationIds: string[] = []
    await expect(reconcilePersistedDurableTurn({
      storage,
      turnId: 'turn-a',
      assistantMessageId: 'msg-old',
      allowNoAssistantRow: false,
      readRows: async () => {
        fetchedConversationIds.push(terminalConversationId!)
        return [{ id: 'msg-old' }]
      },
      attempts: 1,
    })).resolves.toBe(true)
    expect(fetchedConversationIds).toEqual(['conv-old'])
    expect(binding.activeConversationId).toBe('conv-new')
    expect(loadPersistedDurableTurn(storage)).toBeNull()
  })

  it('resets a direct optimistic projection only on the first durable snapshot', () => {
    const direct = createDurableReplayResetGate(true)
    expect(direct.shouldReset({ type: 'text_delta' })).toBe(false)
    expect(direct.shouldReset({ type: 'turn_snapshot' })).toBe(true)
    expect(direct.shouldReset({ type: 'turn_snapshot' })).toBe(false)

    const worker = createDurableReplayResetGate(false)
    expect(worker.shouldReset({ type: 'turn_snapshot' })).toBe(false)
  })

  it('reconnects the same exact turn after clean EOF and resumes from the observed id cursor', async () => {
    const opens: Array<{ turnId: string; afterSeq: number }> = []
    const events: Array<Record<string, unknown>> = []
    const responses = [
      responseFromChunks([
        ': connected\r\nid: 0\r\ndata: {"type":"text_delta","text":"hel"}\r\n\r\n',
      ]),
      responseFromChunks([
        'id: 1\ndata: {"type":"text_delta",\n',
        'data: "text":"lo"}\n\n',
        'data: {"type":"turn_terminal","turnId":"turn-a","conversationId":"conv-a","status":"done","lastSeq":1,"assistantMessageId":"msg-a","continuationNeeded":false}\n\n',
      ]),
    ]

    const result = await tailExactTurnStream({
      turnId: 'turn-a',
      conversationId: 'conv-a',
      open: async (turnId, afterSeq) => {
        opens.push({ turnId, afterSeq })
        return responses.shift()!
      },
      onEvent: (event) => { events.push(event) },
      reconnectDelayMs: 0,
    })

    expect(opens).toEqual([
      { turnId: 'turn-a', afterSeq: -1 },
      { turnId: 'turn-a', afterSeq: 0 },
    ])
    expect(events.map((event) => event.type)).toEqual(['text_delta', 'text_delta', 'turn_terminal'])
    expect(result).toEqual({ lastSeq: 1, terminal: true })
  })

  it('does not advance its cursor to an unsequenced terminal lastSeq it never observed', async () => {
    const cursors: number[] = []
    const result = await tailExactTurnStream({
      turnId: 'turn-a',
      conversationId: 'conv-a',
      initialAfterSeq: 4,
      open: async (_turnId, afterSeq) => {
        cursors.push(afterSeq)
        return responseFromChunks([
          'data: {"type":"turn_terminal","turnId":"turn-a","conversationId":"conv-a","status":"done","lastSeq":8}\n\n',
        ])
      },
      onEvent: () => {},
      reconnectDelayMs: 0,
    })

    expect(cursors).toEqual([4])
    expect(result.lastSeq).toBe(4)
  })

  it('rejects a terminal control for a different turn or conversation', async () => {
    const onEvent = vi.fn()
    await expect(tailExactTurnStream({
      turnId: 'turn-a',
      conversationId: 'conv-a',
      open: async () => responseFromChunks([
        'data: {"type":"turn_terminal","turnId":"turn-newer","conversationId":"conv-a","status":"done","lastSeq":0}\n\n',
      ]),
      onEvent,
      reconnectDelayMs: 0,
    })).rejects.toThrow('turn_stream_identity_mismatch')
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('retries a transient open failure without creating or changing the turn', async () => {
    const opens: Array<{ turnId: string; afterSeq: number }> = []
    const result = await tailExactTurnStream({
      turnId: 'turn-a',
      conversationId: 'conv-a',
      initialAfterSeq: 3,
      open: async (turnId, afterSeq) => {
        opens.push({ turnId, afterSeq })
        if (opens.length === 1) throw new TypeError('network down')
        return responseFromChunks([
          'data: {"type":"turn_terminal","turnId":"turn-a","conversationId":"conv-a","status":"error","lastSeq":3}\n\n',
        ])
      },
      onEvent: () => {},
      reconnectDelayMs: 0,
    })

    expect(opens).toEqual([
      { turnId: 'turn-a', afterSeq: 3 },
      { turnId: 'turn-a', afterSeq: 3 },
    ])
    expect(result.terminal).toBe(true)
  })

  it.each(['turn_snapshot_unavailable', 'turn_replay_unavailable'])(
    'reconnects the same exact turn and cursor after retryable %s control',
    async (message) => {
      const opens: Array<{ turnId: string; afterSeq: number }> = []
      const events: Array<Record<string, unknown>> = []
      const responses = [
        responseFromChunks([
          `data: {"type":"error","message":"${message}"}\n\n`,
        ]),
        responseFromChunks([
          'id: 5\ndata: {"type":"artifact_saved","artifactId":"artifact-before-response"}\n\n',
          'data: {"type":"turn_terminal","turnId":"turn-a","conversationId":"conv-a","status":"done","lastSeq":5,"assistantMessageId":"assistant-a","continuationNeeded":false}\n\n',
        ]),
      ]

      await tailExactTurnStream({
        turnId: 'turn-a',
        conversationId: 'conv-a',
        initialAfterSeq: -1,
        open: async (turnId, afterSeq) => {
          opens.push({ turnId, afterSeq })
          return responses.shift()!
        },
        onEvent: (event) => { events.push(event) },
        reconnectDelayMs: 0,
      })

      expect(opens).toEqual([
        { turnId: 'turn-a', afterSeq: -1 },
        { turnId: 'turn-a', afterSeq: -1 },
      ])
      expect(events.map((event) => event.type)).toEqual([
        'error', 'artifact_saved', 'turn_terminal',
      ])
    },
  )

  it('does not replay UI side effects when the event consumer fails', async () => {
    const opens = vi.fn(async () => responseFromChunks([
      'id: 0\ndata: {"type":"text_delta","delta":"once"}\n\n',
    ]))
    const cursors: number[] = []

    await expect(tailExactTurnStream({
      turnId: 'turn-a',
      conversationId: 'conv-a',
      open: opens,
      onEvent: () => { throw new Error('reducer failed') },
      onCursor: (cursor) => { cursors.push(cursor) },
      reconnectDelayMs: 0,
    })).rejects.toThrow('reducer failed')
    expect(opens).toHaveBeenCalledTimes(1)
    expect(cursors).toEqual([])
  })

  it('marks a direct-stream consumer failure as fatal instead of transport-retryable', async () => {
    const onEvent = vi.fn(() => { throw new Error('direct reducer failed') })
    const error = await consumeJsonSseResponse({
      response: responseFromChunks([
        'data: {"type":"turn_id","id":"turn-a"}\n\n',
      ]),
      onEvent,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(SseEventConsumerError)
    expect(error.message).toBe('direct reducer failed')
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('drains a direct response through EOF after done so post-terminal compaction is not dropped', async () => {
    const events: string[] = []
    await consumeJsonSseResponse({
      response: responseFromChunks([
        'data: {"type":"done","messageId":"assistant-a"}\n\n',
        'data: {"type":"conversation_compacted","conversationId":"conv-b"}\n\n',
      ]),
      onEvent: (event) => { events.push(String(event.type)) },
    })
    expect(events).toEqual(['done', 'conversation_compacted'])
  })

  it('stops an exact durable follower at terminal instead of applying later frames', async () => {
    const events: string[] = []
    await tailExactTurnStream({
      turnId: 'turn-a',
      conversationId: 'conv-a',
      open: async () => responseFromChunks([
        'id: 0\ndata: {"type":"done","messageId":"assistant-a"}\n\n',
        'id: 1\ndata: {"type":"text_delta","delta":"must-not-apply"}\n\n',
      ]),
      onEvent: (event) => { events.push(String(event.type)) },
      reconnectDelayMs: 0,
    })
    expect(events).toEqual(['done'])
  })

  it('has a production-credible default retry window for immediate offline failures', async () => {
    const delays: number[] = []
    await expect(tailExactTurnStream({
      turnId: 'turn-a',
      conversationId: 'conv-a',
      open: async () => { throw new TypeError('offline') },
      onEvent: () => {},
      sleep: async (delayMs) => { delays.push(delayMs) },
    })).rejects.toThrow('turn_stream_reconnect_exhausted')

    expect(delays.reduce((total, delay) => total + delay, 0)).toBeGreaterThanOrEqual(60_000)
  })
})
