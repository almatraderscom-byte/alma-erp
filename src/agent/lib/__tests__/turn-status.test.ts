import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * A1 — server-side turn lifecycle + cross-instance cancel.
 *
 * These lock in the contract the running turn loop depends on:
 *   - The chat route creates a `running` turn row.
 *   - The Stop button's cancel endpoint flips `cancelRequested` (and marks the
 *     turn canceled) — this is the cross-instance signal, because the cancel POST
 *     lands on a different serverless instance than the running turn.
 *   - The running loop polls `isTurnCancelRequested` each iteration and sees it.
 *   - `finalizeTurnIfRunning` only moves a turn that is still running, so a normal
 *     'done' finish can never clobber a cancel (and vice-versa).
 */

type Row = {
  id: string
  conversationId: string
  status: string
  cancelRequested: boolean
  startedAt: Date
  finishedAt: Date | null
}

// Hoisted so the (hoisted) vi.mock factory can reference the same store/mock.
const h = vi.hoisted(() => {
  const store = new Map<string, Row>()
  const state = { seq: 0 }
  const agentTurn = {
    create: vi.fn(async ({ data, select }: { data: Partial<Row>; select?: Record<string, boolean> }) => {
      const id = `turn_${++state.seq}`
      const row: Row = {
        id,
        conversationId: data.conversationId ?? '',
        status: data.status ?? 'running',
        cancelRequested: false,
        startedAt: new Date(),
        finishedAt: null,
      }
      store.set(id, row)
      return select ? { id } : row
    }),
    findUnique: vi.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = store.get(where.id)
      if (!row) return null
      if (!select) return row
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(select)) out[k] = (row as unknown as Record<string, unknown>)[k]
      return out
    }),
    findFirst: vi.fn(async ({ where }: { where: { conversationId: string } }) => {
      const rows = [...store.values()].filter((r) => r.conversationId === where.conversationId)
      rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      return rows[0] ?? null
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; status?: string }; data: Partial<Row> }) => {
      const row = store.get(where.id)
      if (!row) return { count: 0 }
      if (where.status && row.status !== where.status) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    }),
  }
  return { store, state, agentTurn }
})
const { store } = h

vi.mock('@/lib/prisma', () => ({ prisma: { agentTurn: h.agentTurn } }))

import {
  createTurn,
  requestTurnCancel,
  isTurnCancelRequested,
  finalizeTurnIfRunning,
  getLatestTurn,
} from '@/agent/lib/turn-status'

beforeEach(() => {
  store.clear()
  h.state.seq = 0
})

describe('A1 — cancel flag is the signal the loop honors', () => {
  it('cancel endpoint flips the flag; the loop sees it and the turn is canceled', async () => {
    const turnId = await createTurn('conv1')
    expect(turnId).toBeTruthy()

    // Loop's per-iteration check BEFORE any cancel → keeps running.
    expect(await isTurnCancelRequested(turnId)).toBe(false)

    // Owner hits Stop → cancel endpoint runs on another instance.
    expect(await requestTurnCancel(turnId!)).toBe(true)

    // The running loop's NEXT iteration check now sees the flag → it will break.
    expect(await isTurnCancelRequested(turnId)).toBe(true)
    expect(store.get(turnId!)!.status).toBe('canceled')
    expect(store.get(turnId!)!.finishedAt).not.toBeNull()
  })

  it('a normal done-finish cannot clobber a turn the owner already canceled', async () => {
    const turnId = await createTurn('conv2')
    await requestTurnCancel(turnId!) // status = canceled

    // Route's finally tries to finalize — but only if still running. No-op here.
    await finalizeTurnIfRunning(turnId, 'done')
    expect(store.get(turnId!)!.status).toBe('canceled')
  })

  it('finalizeTurnIfRunning moves a running turn to done exactly once', async () => {
    const turnId = await createTurn('conv3')
    await finalizeTurnIfRunning(turnId, 'done')
    expect(store.get(turnId!)!.status).toBe('done')
    // Second attempt (e.g. the safety-net in finally) is a no-op, not an error→done flip.
    await finalizeTurnIfRunning(turnId, 'error')
    expect(store.get(turnId!)!.status).toBe('done')
  })

  it('getLatestTurn returns the running turn so the client can poll on re-open', async () => {
    await createTurn('conv4')
    const latest = await getLatestTurn('conv4')
    expect(latest?.status).toBe('running')
  })

  it('isTurnCancelRequested is fail-safe for a missing/empty turn id', async () => {
    expect(await isTurnCancelRequested(null)).toBe(false)
    expect(await isTurnCancelRequested(undefined)).toBe(false)
    expect(await isTurnCancelRequested('nope')).toBe(false)
  })
})
