import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Phase 3 (roadmap 3.4) — the shared durable event publisher used by INLINE
 * turns. Locks the three guarantees replay correctness depends on:
 *   - adjacent deltas coalesce, but chronology across kinds/controls is exact;
 *   - seq is strictly increasing and each row is written exactly once;
 *   - the cursor deduper resumes strictly after `afterSeq` (Last-Event-ID).
 * Prisma is mocked in-memory; Redis is skipped (no REDIS_URL in tests).
 */

interface Row { turnId: string; seq: number; type: string; payload: unknown }
const rows: Row[] = []
const turnUpdates: Array<{ id: string; lastSeq: number }> = []
/** Per-test failure injection for the durable write (R-3 fail-closed tests). */
const upsertFailures = { remaining: 0, attempts: 0 }
/** Row status served to the publisher's revocation-lease check. */
const leaseState = { status: 'running' }

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentTurnEvent: {
      create: async ({ data }: { data: Row }) => {
        upsertFailures.attempts += 1
        if (upsertFailures.remaining > 0) {
          upsertFailures.remaining -= 1
          throw new Error('db write failed')
        }
        // (turnId, seq) unique constraint — occupied seq is LOUD (P2002).
        if (rows.some((r) => r.turnId === data.turnId && r.seq === data.seq)) {
          throw Object.assign(new Error('unique constraint'), { code: 'P2002' })
        }
        rows.push(data)
        return data
      },
      findUnique: async ({ where }: { where: { turnId_seq: { turnId: string; seq: number } } }) => {
        const r = rows.find((row) => row.turnId === where.turnId_seq.turnId && row.seq === where.turnId_seq.seq)
        return r ? { type: r.type, payload: r.payload } : null
      },
    },
    agentTurn: {
      updateMany: async ({ where, data }: { where: { id: string }; data: { lastSeq: number } }) => {
        turnUpdates.push({ id: where.id, lastSeq: data.lastSeq })
        return { count: 1 }
      },
      findUnique: async () => ({ status: leaseState.status }),
    },
  },
}))

import { createTurnEventPublisher, createSeqDeduper, getReplayEvents } from '@/agent/lib/turn-events'

beforeEach(() => {
  rows.length = 0
  turnUpdates.length = 0
  upsertFailures.remaining = 0
  upsertFailures.attempts = 0
  leaseState.status = 'running'
  delete process.env.REDIS_URL
  delete process.env.LONG_TASK_REDIS_URL
})

describe('Phase 3 — createTurnEventPublisher', () => {
  it('the independent lease timer aborts a quiet executor and later writes are dropped', async () => {
    leaseState.status = 'error'
    const revokedFn = vi.fn()
    const pub = createTurnEventPublisher('t-lease', { coalesceMs: 1, revokeCheckMs: 25, onRevoked: revokedFn })
    // No events flowing — the turn is quiet inside a long tool call. The
    // TIMER alone must detect the claimed-away row (Codex P1 #859 r5).
    await new Promise((resolve) => setTimeout(resolve, 90))
    expect(revokedFn).toHaveBeenCalled()
    // A write attempted after revocation never lands.
    pub.emit({ type: 'tool_end', id: 'x' })
    await pub.finish()
    expect(rows.filter((r) => r.turnId === 't-lease')).toHaveLength(0)
    expect(pub.durabilityHoles()).toBe(0)
  })

  it('an occupied seq holding a FOREIGN row revokes the lease and publishes nothing (Codex P2 r5)', async () => {
    // A reviver's terminal already sits at seq 0 of this turn.
    rows.push({ turnId: 't-foreign', seq: 0, type: 'error', payload: { type: 'error', message: 'turn_stalled_stream_lost' } })
    const revokedFn = vi.fn()
    const pub = createTurnEventPublisher('t-foreign', { coalesceMs: 1, revokeCheckMs: 60_000, onRevoked: revokedFn })
    pub.emit({ type: 'tool_start', id: 'z', name: 'get_orders' })
    // Let the write chain hit the foreign row while the run is still live —
    // finish() itself releases the lease (normal settlement).
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(revokedFn).toHaveBeenCalled()
    await pub.finish()

    // The foreign terminal still owns seq 0 — our payload never replaced or
    // shadowed it, and the drop is not counted as a durability hole.
    expect(rows.filter((r) => r.turnId === 't-foreign')).toHaveLength(1)
    expect(rows[rows.length - 1].type).toBe('error')
    expect(pub.durabilityHoles()).toBe(0)
  })

  it('our own crash-retry duplicate at an occupied seq still counts as stored', async () => {
    const pub = createTurnEventPublisher('t-dup', { coalesceMs: 1 })
    pub.emit({ type: 'tool_start', id: 'a', name: 'get_orders' })
    await pub.finish()
    // Same event body already durable at seq 0 — a retried write of the SAME
    // event must be success, not a revocation.
    const pub2 = createTurnEventPublisher('t-dup', { coalesceMs: 1 })
    pub2.emit({ type: 'tool_start', id: 'a', name: 'get_orders' })
    const lastSeq = await pub2.finish()
    expect(lastSeq).toBe(0)
    expect(pub2.durabilityHoles()).toBe(0)
  })

  it('releaseLease lets a normally-settling executor flush its tail even after the row is finalized', async () => {
    const revokedFn = vi.fn()
    const pub = createTurnEventPublisher('t-release', { coalesceMs: 1, revokeCheckMs: 25, onRevoked: revokedFn })
    // Normal completion order: releaseLease → finalize (status leaves
    // 'running') → the durable tail still flushing (Codex P2 #859 r6).
    pub.releaseLease()
    leaseState.status = 'done'
    pub.emit({ type: 'done', message: 'ok' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    await pub.finish()

    expect(revokedFn).not.toHaveBeenCalled()
    expect(rows.filter((r) => r.turnId === 't-release')).toHaveLength(1)
    expect(pub.durabilityHoles()).toBe(0)
  })

  it('a healthy running row is untouched by the lease check', async () => {
    const revokedFn = vi.fn()
    const pub = createTurnEventPublisher('t-lease2', { coalesceMs: 1, revokeCheckMs: 25, onRevoked: revokedFn })
    pub.emit({ type: 'tool_start', id: 'y', name: 'get_sales_summary' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    await pub.finish()

    expect(revokedFn).not.toHaveBeenCalled()
    expect(rows.filter((r) => r.turnId === 't-lease2')).toHaveLength(1)
  })

  it('coalesces adjacent deltas and flushes them BEFORE a control event', async () => {
    const pub = createTurnEventPublisher('t1', { coalesceMs: 5_000 })
    pub.emit({ type: 'text_delta', delta: 'আজ' })
    pub.emit({ type: 'text_delta', delta: 'কের ' })
    pub.emit({ type: 'text_delta', delta: 'বিক্রি' })
    pub.emit({ type: 'tool_start', id: 't', name: 'get_sales_summary' })
    const lastSeq = await pub.finish()

    expect(rows.map((r) => r.type)).toEqual(['text_delta', 'tool_start'])
    expect((rows[0].payload as { delta: string }).delta).toBe('আজকের বিক্রি')
    expect(rows.map((r) => r.seq)).toEqual([0, 1])
    expect(lastSeq).toBe(1)
  })

  it('keeps chronology when the delta KIND switches (thinking → text)', async () => {
    const pub = createTurnEventPublisher('t2', { coalesceMs: 5_000 })
    pub.emit({ type: 'thinking_delta', delta: 'ভাবছি…' })
    pub.emit({ type: 'text_delta', delta: 'বস, ' })
    pub.emit({ type: 'text_delta', delta: 'আজ মঙ্গলবার।' })
    pub.emit({ type: 'done', messageId: 'm9' })
    await pub.finish()

    expect(rows.map((r) => r.type)).toEqual(['thinking_delta', 'text_delta', 'done'])
    expect((rows[1].payload as { delta: string }).delta).toBe('বস, আজ মঙ্গলবার।')
  })

  it('flushes oversize deltas early (maxDeltaChars) with increasing seq', async () => {
    const pub = createTurnEventPublisher('t3', { coalesceMs: 5_000, maxDeltaChars: 6 })
    pub.emit({ type: 'text_delta', delta: 'aaaa' })
    pub.emit({ type: 'text_delta', delta: 'bbbb' })   // 8 ≥ 6 → flush
    pub.emit({ type: 'text_delta', delta: 'cc' })
    await pub.finish()

    expect(rows.map((r) => r.seq)).toEqual([0, 1])
    expect((rows[0].payload as { delta: string }).delta).toBe('aaaabbbb')
    expect((rows[1].payload as { delta: string }).delta).toBe('cc')
  })

  it('bumps AgentTurn.lastSeq as rows land (liveness signal)', async () => {
    const pub = createTurnEventPublisher('t4', { coalesceMs: 5_000 })
    pub.emit({ type: 'conversation_id', id: 'c1' })
    pub.emit({ type: 'done', messageId: 'm1' })
    await pub.finish()

    expect(turnUpdates.at(-1)).toEqual({ id: 't4', lastSeq: 1 })
  })
})

describe('Phase 3 — replay cursor semantics', () => {
  it('deduper seeded with afterSeq resumes strictly after the cursor', () => {
    const dedup = createSeqDeduper(7)
    expect(dedup.accept(5)).toBe(false)
    expect(dedup.accept(7)).toBe(false)
    expect(dedup.accept(8)).toBe(true)
    expect(dedup.accept(8)).toBe(false)
    expect(dedup.accept(9)).toBe(true)
  })

  it('getReplayEvents fails open to [] by default and throws for the stream endpoint (R-3)', async () => {
    // The mock has no findMany. Advisory callers keep the fail-open [] …
    const out = await getReplayEvents('missing-turn', 3)
    expect(out).toEqual([])
    // … but the stream endpoint must see the failure: a replay it cannot read
    // ends the stream with an explicit error instead of a live-only tail.
    await expect(getReplayEvents('missing-turn', 3, 5000, { throwOnError: true })).rejects.toThrow()
  })
})

describe('R-3 — durable writes are fail-closed (handoff F-09)', () => {
  it('retries a transient durable failure and then publishes + bumps lastSeq once', async () => {
    upsertFailures.remaining = 2   // first two attempts fail, third succeeds
    const pub = createTurnEventPublisher('t5', { coalesceMs: 5_000, retryDelaysMs: [1, 1, 1] })
    pub.emit({ type: 'tool_start', id: 't', name: 'get_orders' })
    const lastSeq = await pub.finish()

    expect(upsertFailures.attempts).toBe(3)
    expect(rows.map((r) => [r.seq, r.type])).toEqual([[0, 'tool_start']])
    expect(turnUpdates).toEqual([{ id: 't5', lastSeq: 0 }])
    expect(lastSeq).toBe(0)
    expect(pub.durabilityHoles()).toBe(0)
  })

  it('an event that can never be stored is not published and does not advance lastSeq', async () => {
    upsertFailures.remaining = 99
    const pub = createTurnEventPublisher('t6', { coalesceMs: 5_000, retryDelaysMs: [1, 1] })
    pub.emit({ type: 'tool_start', id: 't', name: 'lost' })   // control event → written immediately
    // Let the 3 attempts fail, then storage recovers for the next event.
    await new Promise((r) => setTimeout(r, 100))
    upsertFailures.remaining = 0
    pub.emit({ type: 'done', messageId: 'm1' })
    await pub.finish()

    expect(rows.map((r) => [r.seq, r.type])).toEqual([[1, 'done']])
    expect(turnUpdates).toEqual([{ id: 't6', lastSeq: 1 }])   // no lastSeq for the hole
    expect(pub.durabilityHoles()).toBe(1)
  })
})

describe('R-3 round 2 — terminal durability repair (Codex P1 #837)', () => {
  it('a terminal whose write failed is repaired with an explicit durable error terminal', async () => {
    upsertFailures.remaining = 3   // the `done` fails every attempt…
    const pub = createTurnEventPublisher('t7', { coalesceMs: 5_000, retryDelaysMs: [1, 1] })
    pub.emit({ type: 'done', messageId: 'm1' })
    // Wait for the three failing attempts to actually happen (a fixed 30 ms
    // sleep was flaky under CPU load: storage came back before the last
    // attempt and the `done` landed instead of being abandoned).
    const deadline = Date.now() + 5_000
    while (upsertFailures.remaining > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 10))
    upsertFailures.remaining = 0   // …storage is back for the repair
    const lastSeq = await pub.finish()
    expect(rows.map((r) => [r.seq, r.type, (r.payload as { message?: string }).message])).toEqual([
      [1, 'error', 'turn_terminal_not_durable:done'],
    ])
    expect(lastSeq).toBe(1)
    expect(pub.durabilityHoles()).toBe(1)
  })

  it('finish() rejects when no terminal can be stored at all', async () => {
    upsertFailures.remaining = 99
    const pub = createTurnEventPublisher('t8', { coalesceMs: 5_000, retryDelaysMs: [1, 1] })
    pub.emit({ type: 'done', messageId: 'm1' })
    await expect(pub.finish()).rejects.toThrow(/terminal event could not be stored durably/)
    expect(rows).toHaveLength(0)
  })
})
