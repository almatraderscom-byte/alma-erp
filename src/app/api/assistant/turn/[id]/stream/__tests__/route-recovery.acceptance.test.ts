import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadPersistedDurableTurn,
  reconcilePersistedDurableTurn,
  savePersistedDurableTurn,
  tailExactTurnStream,
  type DurableTurnStorage,
} from '@/agent/lib/durable-turn-stream-client'

/**
 * Production-like route + client recovery for the audited zero-event turn.
 *
 * Reproduces, against the REAL stream route handler and the REAL durable client:
 *   - Redis unavailable (subscribe never settles until the deadline aborts it);
 *   - the clean proxy EOF at 300 000 ms (`maxDuration = 300`);
 *   - an exact-turn, exact-cursor reconnect (never conversation-latest);
 *   - the database terminal at 473 871 ms with ZERO durable event rows (8c60);
 *   - zero prompt reruns — the observation endpoint never enqueues work.
 */

const INCIDENT = {
  conversationId: '9598d574-4587-4449-abc2-7c6ba47407f2',
  turnId: '8c60fbe3-4c22-4f4e-9a1e-zero-event-turn',
  assistantMessageId: 'assistant-after-473871ms',
  terminalAtMs: 473_871,
  proxyEofAtMs: 300_000,
} as const

const harness = vi.hoisted(() => ({
  /** Durable rows for this turn. The 8c60 scenario keeps this empty. */
  rows: [] as Array<{ seq: number; type: string; payload: unknown }>,
  /** Milliseconds after which getTurnSnapshot reports `done`. */
  terminalAtMs: 473_871,
  statusReads: [] as number[],
  replayReads: [] as number[],
  subscribeAttempts: 0,
  pollStarts: 0,
  /** Any call here would mean the observation endpoint ran owner work. */
  ownerWorkStarted: 0,
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('next-auth/jwt', () => ({ getToken: async () => ({ sub: 'owner' }) }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: () => true }))

vi.mock('@/agent/lib/turn-status', () => ({
  getTurnSnapshot: async (turnId: string) => {
    harness.statusReads.push(Date.now())
    const done = Date.now() >= harness.terminalAtMs
    return {
      id: turnId,
      conversationId: '9598d574-4587-4449-abc2-7c6ba47407f2',
      status: done ? 'done' : 'running',
      lastSeq: harness.rows.length ? harness.rows[harness.rows.length - 1].seq : -1,
      assistantMessageId: done ? 'assistant-after-473871ms' : null,
      continuationNeeded: false,
      versions: {},
    }
  },
}))

vi.mock('@/agent/lib/turn-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/lib/turn-events')>()
  return {
    ...actual,
    getReplayEvents: async (_turnId: string, afterSeq: number) => {
      harness.replayReads.push(afterSeq)
      return harness.rows.filter((row) => row.seq > afterSeq)
    },
    // Redis outage: ioredis with maxRetriesPerRequest:null reconnects forever,
    // so the connect promise settles only when the tailer's deadline aborts it.
    subscribeTurnEvents: async (
      _turnId: string,
      _onEvent: unknown,
      opts?: { signal?: AbortSignal },
    ) => {
      harness.subscribeAttempts += 1
      return new Promise<null>((resolve) => {
        opts?.signal?.addEventListener('abort', () => resolve(null), { once: true })
      })
    },
    pollTurnEvents: () => {
      harness.pollStarts += 1
      return { close: async () => {} }
    },
  }
})

// The turn queue is the ONLY way owner work starts. It must never be touched by
// an observation reconnect.
vi.mock('@/agent/lib/turn-queue', () => ({
  enqueueTurn: async () => { harness.ownerWorkStarted += 1; return null },
}))

import { GET } from '@/app/api/assistant/turn/[id]/stream/route'

function memoryStorage(): DurableTurnStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) },
  }
}

/** Call the real route handler exactly as the platform would. */
function routeRequest(turnId: string, afterSeq: number, signal: AbortSignal) {
  const url = new URL(`http://localhost/api/assistant/turn/${turnId}/stream`)
  if (afterSeq >= 0) url.searchParams.set('afterSeq', String(afterSeq))
  const req = new Request(url, { signal })
  // The route reads `req.nextUrl`; NextRequest is a thin wrapper over Request.
  Object.defineProperty(req, 'nextUrl', { value: url, configurable: true })

  return GET(req as any, { params: Promise.resolve({ id: turnId }) })
}

beforeEach(() => {
  harness.rows = []
  harness.terminalAtMs = INCIDENT.terminalAtMs
  harness.statusReads = []
  harness.replayReads = []
  harness.subscribeAttempts = 0
  harness.pollStarts = 0
  harness.ownerWorkStarted = 0
})

describe('stream route + durable client recovery (8c60 zero-event terminal)', () => {
  it('survives Redis-down and the 300s EOF, then reports the 474s DB terminal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const opens: Array<{ at: number; turnId: string; afterSeq: number }> = []
      const seen: Array<Record<string, unknown>> = []
      const cursors: number[] = []
      const storage = memoryStorage()
      const aborts: AbortController[] = []
      let firstEofAt: number | null = null
      let resolvedAt: number | null = null

      savePersistedDurableTurn(storage, {
        turnId: INCIDENT.turnId,
        conversationId: INCIDENT.conversationId,
        lastSeq: -1,
      })

      const open = async (turnId: string, afterSeq: number): Promise<Response> => {
        const connection = opens.length + 1
        opens.push({ at: Date.now(), turnId, afterSeq })
        const abort = new AbortController()
        aborts.push(abort)
        const response = await routeRequest(turnId, afterSeq, abort.signal)
        if (connection === 1) {
          // The platform cuts the socket at maxDuration. The route sees the
          // client abort; the body ends cleanly (EOF), not with an error.
          setTimeout(() => {
            firstEofAt = Date.now()
            abort.abort()
          }, INCIDENT.proxyEofAtMs)
        }
        return response
      }

      const recovery = tailExactTurnStream({
        turnId: INCIDENT.turnId,
        conversationId: INCIDENT.conversationId,
        initialAfterSeq: -1,
        open,
        onEvent(event) { seen.push(event) },
        onCursor(seq) {
          cursors.push(seq)
          savePersistedDurableTurn(storage, {
            turnId: INCIDENT.turnId,
            conversationId: INCIDENT.conversationId,
            lastSeq: seq,
          })
        },
        maxReconnects: 4,
        reconnectDelayMs: 0,
        sleep: async () => {},
      }).then((result) => { resolvedAt = Date.now(); return result })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(INCIDENT.proxyEofAtMs)
      await vi.advanceTimersByTimeAsync(175_000)

      await expect(recovery).resolves.toEqual({ lastSeq: -1, terminal: true })
      expect(firstEofAt).toBe(INCIDENT.proxyEofAtMs)

      // Exactly one reconnect, on the exact turn, from the exact cursor. No
      // conversation-latest attach, no second turn id.
      expect(opens).toEqual([
        { at: 0, turnId: INCIDENT.turnId, afterSeq: -1 },
        { at: INCIDENT.proxyEofAtMs, turnId: INCIDENT.turnId, afterSeq: -1 },
      ])

      // Redis was tried on each connection and never worked; the durable
      // fallbacks (replay + poll + exact status) carried the turn.
      expect(harness.subscribeAttempts).toBe(2)
      expect(harness.pollStarts).toBe(2)
      expect(harness.replayReads.every((after) => after === -1)).toBe(true)

      // The terminal came from the exact AgentTurn lifecycle row at ~474s.
      expect(resolvedAt!).toBeGreaterThanOrEqual(INCIDENT.terminalAtMs)
      expect(resolvedAt!).toBeLessThanOrEqual(INCIDENT.terminalAtMs + 2_000)
      expect(seen.at(-1)).toMatchObject({
        type: 'turn_terminal',
        turnId: INCIDENT.turnId,
        conversationId: INCIDENT.conversationId,
        status: 'done',
        lastSeq: -1,
        assistantMessageId: INCIDENT.assistantMessageId,
        continuationNeeded: false,
      })

      // Zero durable events: no cursor ever advanced, nothing was persisted.
      expect(cursors).toEqual([])
      expect(seen.filter((event) => event.type === 'text_delta')).toEqual([])
      // And the observation path never started owner work.
      expect(harness.ownerWorkStarted).toBe(0)

      // Cold-recovery hint clears only once the exact assistant row is readable.
      const cleared = await reconcilePersistedDurableTurn({
        storage,
        turnId: INCIDENT.turnId,
        assistantMessageId: INCIDENT.assistantMessageId,
        allowNoAssistantRow: false,
        readRows: async () => [{ id: INCIDENT.assistantMessageId }],
        attempts: 1,
        sleep: async () => {},
      })
      expect(cleared).toBe(true)
      expect(loadPersistedDurableTurn(storage)).toBeNull()

      for (const abort of aborts) abort.abort()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnects an event-bearing turn at the exact cursor and replays nothing twice', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      harness.rows = [
        { seq: 0, type: 'text_delta', payload: { type: 'text_delta', delta: 'Boss, ' } },
        { seq: 1, type: 'text_delta', payload: { type: 'text_delta', delta: 'দেখছি।' } },
      ]
      harness.terminalAtMs = INCIDENT.terminalAtMs

      const opens: Array<{ turnId: string; afterSeq: number }> = []
      const seen: Array<Record<string, unknown>> = []
      const cursors: number[] = []
      const aborts: AbortController[] = []

      const open = async (turnId: string, afterSeq: number): Promise<Response> => {
        const connection = opens.length + 1
        opens.push({ turnId, afterSeq })
        const abort = new AbortController()
        aborts.push(abort)
        const response = await routeRequest(turnId, afterSeq, abort.signal)
        if (connection === 1) setTimeout(() => abort.abort(), INCIDENT.proxyEofAtMs)
        return response
      }

      const recovery = tailExactTurnStream({
        turnId: INCIDENT.turnId,
        conversationId: INCIDENT.conversationId,
        initialAfterSeq: -1,
        open,
        onEvent(event) { seen.push(event) },
        onCursor(seq) { cursors.push(seq) },
        maxReconnects: 4,
        reconnectDelayMs: 0,
        sleep: async () => {},
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(INCIDENT.proxyEofAtMs)
      await vi.advanceTimersByTimeAsync(175_000)

      await expect(recovery).resolves.toEqual({ lastSeq: 1, terminal: true })
      // The reconnect asked for exactly what the client had applied.
      expect(opens).toEqual([
        { turnId: INCIDENT.turnId, afterSeq: -1 },
        { turnId: INCIDENT.turnId, afterSeq: 1 },
      ])
      expect(harness.replayReads).toContain(1)
      expect(cursors).toEqual([0, 1])
      // Each durable row was applied exactly once across both connections.
      expect(seen.filter((event) => event.type === 'text_delta')).toEqual([
        { type: 'text_delta', delta: 'Boss, ' },
        { type: 'text_delta', delta: 'দেখছি।' },
      ])
      expect(harness.ownerWorkStarted).toBe(0)

      for (const abort of aborts) abort.abort()
    } finally {
      vi.useRealTimers()
    }
  })
})
